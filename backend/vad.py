"""Silero VAD pre-pass: strip silence before Whisper and pyannote ever see it.

    Audio → DeepFilterNet (denoise.py) → Silero VAD → speech only → Whisper / pyannote

Meetings are mostly dead air. Feeding that dead air to Whisper and pyannote
costs CPU time proportional to its length and buys nothing — worse, Whisper
hallucinates text into long silences. Cutting the silence out first makes both
stages faster and the transcript cleaner.

The model is Silero VAD (https://github.com/snakers4/silero-vad), loaded from
the upstream `silero-vad` package so we track the model the project actually
ships (v6) rather than the older copy vendored inside faster-whisper. When that
package isn't installed we fall back to faster-whisper's bundled copy — same
family of model, so the pre-pass keeps working either way. Both are asked for
timestamps in *samples*, which is the format the bookkeeping below expects.

DeepFilterNet runs first, and that ordering is deliberate: a noisy recording
pushes the noise floor up, and Silero then either clips quiet talkers or marks
a running fan as speech. Given clean audio its decisions get sharper.

The bookkeeping is the whole trick here. Concatenating speech regions produces
a *compressed* timeline in which every timestamp is wrong relative to the audio
file the user plays back. ``SpeechAudio.to_original`` maps compressed time back
onto the real recording, and main.py applies it to every word and speaker turn
before anything downstream sees them.

Config (env / .env):
  * SILERO_VAD          — "0" disables the pre-pass entirely (default on)
  * SILERO_VAD_ONNX     — "0" uses the PyTorch weights instead of ONNX (default ONNX)
  * VAD_THRESHOLD       — speech probability cutoff, 0-1 (default 0.3)
  * VAD_MIN_SILENCE_MS  — silence this long ends a speech chunk (default 1000)
  * VAD_SPEECH_PAD_MS   — padding kept either side of speech (default 400)
  * VAD_MIN_SPEECH_MS   — drop speech chunks shorter than this (default 0)
"""

from __future__ import annotations

import os
import threading
from typing import List, Optional

import numpy as np
from faster_whisper.audio import decode_audio
from faster_whisper.vad import (
    SpeechTimestampsMap,
    VadOptions,
    collect_chunks,
)
from faster_whisper.vad import get_speech_timestamps as _bundled_get_speech_timestamps

SAMPLE_RATE = 16000

ENABLED = os.environ.get("SILERO_VAD", "1") in ("1", "true", "True")

# ONNX runs the same weights noticeably faster on CPU, which is what this box
# is. Set SILERO_VAD_ONNX=0 to use the TorchScript model instead.
USE_ONNX = os.environ.get("SILERO_VAD_ONNX", "1") in ("1", "true", "True")

# Deliberately more cautious than Silero's defaults. This pre-pass decides what
# Whisper is even allowed to hear, so the cost of trimming real speech is far
# higher than the cost of leaving some silence in: a lower threshold and
# generous padding keep quiet talkers and trailing syllables.
THRESHOLD = float(os.environ.get("VAD_THRESHOLD", "0.3"))
MIN_SILENCE_MS = int(os.environ.get("VAD_MIN_SILENCE_MS", "1000"))
SPEECH_PAD_MS = int(os.environ.get("VAD_SPEECH_PAD_MS", "400"))
MIN_SPEECH_MS = int(os.environ.get("VAD_MIN_SPEECH_MS", "0"))


class SpeechAudio:
    """Speech-only audio plus the map back to the original timeline."""

    def __init__(self, audio: np.ndarray, chunks: List[dict], original_samples: int):
        self.audio = audio
        self.chunks = chunks
        self._map = SpeechTimestampsMap(chunks, SAMPLE_RATE)
        self.original_duration = original_samples / SAMPLE_RATE
        self.speech_duration = len(audio) / SAMPLE_RATE

    @property
    def removed_duration(self) -> float:
        return max(0.0, self.original_duration - self.speech_duration)

    @property
    def kept_ratio(self) -> float:
        return self.speech_duration / self.original_duration if self.original_duration else 1.0

    def to_original(self, seconds: float, *, is_end: bool = False) -> float:
        """Map a timestamp from the trimmed timeline back onto the real audio."""
        return self._map.get_original_time(float(seconds), is_end=is_end)


def decode(audio_path: str) -> np.ndarray:
    """Decode any container/codec to 16 kHz mono float32 — one decode, reused."""
    return decode_audio(audio_path, sampling_rate=SAMPLE_RATE)


# The upstream model is stateful — get_speech_timestamps resets and then walks
# it window by window — so two concurrent uploads sharing one instance would
# read each other's hidden state. FastAPI serves our sync endpoints from a
# threadpool, so that's a real possibility; the lock makes detection serial.
_model = None
_model_lock = threading.Lock()
_model_failed = False

BACKEND = "unknown"


def _get_model():
    """Load the upstream Silero VAD model once. None ⇒ use the bundled copy."""
    global _model, _model_failed, BACKEND
    if _model is not None or _model_failed:
        return _model
    try:
        from silero_vad import load_silero_vad

        _model = load_silero_vad(onnx=USE_ONNX)
        BACKEND = f"silero-vad ({'onnx' if USE_ONNX else 'torch'})"
    except Exception as exc:  # noqa: BLE001 - the bundled model still works
        _model_failed = True
        BACKEND = "faster-whisper bundled"
        print(f"[vad] silero-vad package unavailable, using bundled model: {exc}")
    return _model


def backend() -> str:
    """Which Silero model is in use — resolves it on first call (for /health)."""
    if not ENABLED:
        return "disabled"
    with _model_lock:
        _get_model()
    return BACKEND


def _detect(audio: np.ndarray, options: VadOptions) -> List[dict]:
    """Speech regions as ``[{"start", "end"}]`` in samples, via whichever model loaded."""
    model = _get_model()
    if model is None:
        return _bundled_get_speech_timestamps(audio, options, sampling_rate=SAMPLE_RATE)

    import torch
    from silero_vad import get_speech_timestamps as silero_get_speech_timestamps

    # from_numpy wants a contiguous float32 buffer and warns on a read-only one.
    # Both conversions are no-ops for audio that arrives straight from decode()
    # or denoise.denoise(), so the common path stays copy-free — this only pays
    # for itself when a caller hands us a slice or a frozen view.
    buffer = np.ascontiguousarray(audio, dtype=np.float32)
    if not buffer.flags.writeable:
        buffer = buffer.copy()
    tensor = torch.from_numpy(buffer)

    with torch.no_grad():
        return silero_get_speech_timestamps(
            tensor,
            model,
            sampling_rate=SAMPLE_RATE,
            threshold=options.threshold,
            min_speech_duration_ms=options.min_speech_duration_ms,
            min_silence_duration_ms=options.min_silence_duration_ms,
            speech_pad_ms=options.speech_pad_ms,
            # Samples, not seconds: SpeechTimestampsMap and collect_chunks both
            # work in samples, and returning seconds here would silently shift
            # every downstream timestamp.
            return_seconds=False,
        )


def trim_silence(audio: np.ndarray) -> Optional[SpeechAudio]:
    """Cut the silence out of ``audio``.

    Returns None — meaning "use the original audio unchanged" — when the
    pre-pass is disabled, when the model can't run, or when it finds no speech
    at all. A recording we can't analyse must still be transcribed in full;
    silently handing Whisper an empty array would lose the whole conversation.
    """
    if not ENABLED or audio.size == 0:
        return None

    options = VadOptions(
        threshold=THRESHOLD,
        min_speech_duration_ms=MIN_SPEECH_MS,
        min_silence_duration_ms=MIN_SILENCE_MS,
        speech_pad_ms=SPEECH_PAD_MS,
    )

    try:
        with _model_lock:
            chunks = _detect(audio, options)
    except Exception as exc:  # noqa: BLE001 - never fail a transcription over VAD
        print(f"[vad] Silero VAD unavailable, using full audio: {exc}")
        return None

    if not chunks:
        # Either genuine silence or a voice the model didn't recognise. Either
        # way, let Whisper decide rather than throwing the recording away.
        print("[vad] no speech detected; using full audio")
        return None

    speech_audio, _ = collect_chunks(audio, chunks, sampling_rate=SAMPLE_RATE)
    return SpeechAudio(speech_audio[0], chunks, len(audio))
