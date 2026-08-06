"""Silero VAD pre-pass: strip silence before Whisper and pyannote ever see it.

    Audio → Silero VAD → speech segments only → Whisper / pyannote → Transcript

Meetings are mostly dead air. Feeding that dead air to Whisper and pyannote
costs CPU time proportional to its length and buys nothing — worse, Whisper
hallucinates text into long silences. Cutting the silence out first makes both
stages faster and the transcript cleaner.

The model is Silero VAD (https://github.com/snakers4/silero-vad). We use the
ONNX copy that ships inside faster-whisper rather than adding the `silero-vad`
package: it is the same model, already installed, and it comes with the
timestamp bookkeeping we need.

That bookkeeping is the whole trick. Concatenating speech regions produces a
*compressed* timeline in which every timestamp is wrong relative to the audio
file the user plays back. ``SpeechAudio.to_original`` maps compressed time back
onto the real recording, and main.py applies it to every word and speaker turn
before anything downstream sees them.

Config (env / .env):
  * SILERO_VAD          — "0" disables the pre-pass entirely (default on)
  * VAD_THRESHOLD       — speech probability cutoff, 0-1 (default 0.3)
  * VAD_MIN_SILENCE_MS  — silence this long ends a speech chunk (default 1000)
  * VAD_SPEECH_PAD_MS   — padding kept either side of speech (default 400)
  * VAD_MIN_SPEECH_MS   — drop speech chunks shorter than this (default 0)
"""

from __future__ import annotations

import os
from typing import List, Optional

import numpy as np
from faster_whisper.audio import decode_audio
from faster_whisper.vad import (
    SpeechTimestampsMap,
    VadOptions,
    collect_chunks,
    get_speech_timestamps,
)

SAMPLE_RATE = 16000

ENABLED = os.environ.get("SILERO_VAD", "1") in ("1", "true", "True")

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
        chunks = get_speech_timestamps(audio, options, sampling_rate=SAMPLE_RATE)
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
