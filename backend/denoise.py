"""DeepFilterNet noise suppression: scrub the room before anything listens.

    Audio → DeepFilterNet → Silero VAD (vad.py) → Whisper / pyannote

Meeting recordings arrive full of air conditioning, keyboard clatter, laptop
fan, street noise and the hiss of a cheap mic. All three downstream stages pay
for it: Whisper mis-hears words and hallucinates during noisy silence, pyannote
splits one speaker into several when the noise floor shifts, and Silero VAD
either clips quiet talkers (noise raises its threshold in practice) or keeps
whole minutes of fan noise as "speech". Removing the noise first makes each of
them measurably better, so this runs ahead of the VAD pre-pass.

The model is DeepFilterNet3 (https://github.com/Rikorose/DeepFilterNet).

Why the binary and not `pip install deepfilternet`
--------------------------------------------------
The Python package can't be installed into this environment without breaking
it: it pins ``numpy<2`` (we're on 2.x, as are torch and faster-whisper), its
native half (``deepfilterlib``) has no wheel for Python 3.12 and needs a Rust
toolchain to build, and ``df/io.py`` imports ``torchaudio.backend.common``,
which torchaudio 2.x removed. The upstream project publishes a self-contained
``deep-filter`` binary from the same release, same model, no dependencies —
so we shell out to it, exactly as diarization.py already shells out to ffmpeg.

``scripts/install_deep_filter.sh`` fetches it into ``backend/bin/``.

Timeline safety
---------------
Every timestamp the user ever sees is an offset into the *original* recording,
so denoising must not shift the audio by even a few milliseconds. Two things
guarantee that:

  * ``-D`` (compensate-delay) makes the binary undo its own STFT + lookahead
    latency, so output sample *i* is input sample *i*. This is verified, not
    assumed — without it everything downstream would drift ~30 ms late.
  * The binary still returns ~1440 samples fewer than it was given (the tail
    that falls inside the lookahead). ``_run_chunk`` pads that back, so the
    array handed onward has exactly the length it started with.

Long recordings are processed in chunks, in parallel across cores. Each chunk
is decoded with a lead-in of real audio before its start, which is denoised for
context and then discarded — the model therefore never starts from a cold state
mid-conversation, and because the lead-in is dropped rather than blended the
concatenation stays sample-exact.

Config (env / .env):
  * DEEPFILTER            — "0" disables denoising entirely (default on)
  * DEEPFILTER_BIN        — path to the deep-filter binary (default backend/bin)
  * DEEPFILTER_ATTEN_DB   — attenuation limit in dB; lower = gentler (default 100 = full)
  * DEEPFILTER_POSTFILTER — "1" enables the post-filter (crisper, slightly more artefacts)
  * DEEPFILTER_CHUNK_SEC  — seconds of audio per parallel chunk (default 300)
  * DEEPFILTER_WORKERS    — parallel chunk workers (default: cores/4, capped 4)
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import List, Optional

import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly

# DeepFilterNet3 is trained at 48 kHz and only accepts 48 kHz input.
DF_SAMPLE_RATE = 48000

# What the rest of the pipeline speaks (Whisper, Silero VAD and pyannote all
# want 16 kHz mono float32). We hand back audio already at that rate so the
# caller can skip its own decode.
TARGET_SAMPLE_RATE = 16000

ENABLED = os.environ.get("DEEPFILTER", "1") in ("1", "true", "True")

_DEFAULT_BIN = Path(__file__).resolve().parent / "bin" / "deep-filter"
BIN = os.environ.get("DEEPFILTER_BIN") or str(_DEFAULT_BIN)

# 100 dB means "no limit" — remove as much noise as the model wants to. Lower
# it (e.g. 20) to mix some of the original back in, which sounds more natural
# to a human but leaves noise in for Whisper. We optimise for the machine.
ATTEN_LIM_DB = os.environ.get("DEEPFILTER_ATTEN_DB", "100")

# The post-filter sharpens speech at the cost of occasional artefacts. Off by
# default: artefacts are exactly what makes Whisper invent words.
POST_FILTER = os.environ.get("DEEPFILTER_POSTFILTER", "0") in ("1", "true", "True")

CHUNK_SEC = float(os.environ.get("DEEPFILTER_CHUNK_SEC", "300"))

# Real audio decoded before each chunk's start, denoised for model context and
# then thrown away. 2 s is far longer than DeepFilterNet's receptive field, so
# the seam is inaudible.
LEAD_IN_SEC = 2.0


def _default_workers() -> int:
    # Each worker is a separate process holding its own copy of the audio, and
    # the binary is already multi-threaded, so oversubscribing costs more in
    # memory and contention than it buys in speed.
    return max(1, min(4, (os.cpu_count() or 4) // 4))


WORKERS = int(os.environ.get("DEEPFILTER_WORKERS", "0")) or _default_workers()


def is_available() -> bool:
    """True when denoising is switched on and the binary is actually runnable."""
    return ENABLED and bool(BIN) and os.access(BIN, os.X_OK)


def unavailable_reason() -> Optional[str]:
    if not ENABLED:
        return "Disabled via DEEPFILTER=0."
    if not os.access(BIN, os.X_OK):
        return (
            f"deep-filter binary not found or not executable at '{BIN}'. "
            "Run backend/scripts/install_deep_filter.sh, or set DEEPFILTER_BIN."
        )
    return None


def _probe_duration(audio_path: str) -> float:
    """Length of the recording in seconds, or 0.0 if ffprobe can't tell us."""
    try:
        out = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                audio_path,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        return float(out.stdout.decode().strip())
    except Exception:  # noqa: BLE001 - falls back to a single chunk
        return 0.0


def _decode_window(audio_path: str, dest: Path, start: float, duration: Optional[float]) -> int:
    """Decode ``[start, start+duration)`` to a 48 kHz mono 16-bit wav at ``dest``.

    Returns the number of samples written. ``-ss`` before ``-i`` seeks by
    keyframe on some containers; putting it after ``-i`` costs a little decode
    time but is sample-accurate, which is what the timeline maths relies on.
    """
    cmd = ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", audio_path]
    if start > 0:
        cmd += ["-ss", f"{start:.6f}"]
    if duration is not None:
        cmd += ["-t", f"{duration:.6f}"]
    cmd += ["-ac", "1", "-ar", str(DF_SAMPLE_RATE), "-c:a", "pcm_s16le", str(dest)]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)
    _, data = wavfile.read(dest)
    return len(data)


def _fit(audio: np.ndarray, length: int) -> np.ndarray:
    """Force ``audio`` to exactly ``length`` samples, zero-padding if it's short."""
    if len(audio) < length:
        return np.pad(audio, (0, length - len(audio)))
    return audio[:length]


def _run_chunk(
    work_dir: Path,
    index: int,
    audio_path: str,
    start: float,
    duration: Optional[float],
    expected: Optional[int],
) -> np.ndarray:
    """Denoise one window and return it as 16 kHz mono float32, lead-in removed.

    ``expected`` is the exact number of 16 kHz samples this window owns on the
    timeline; the result is padded or trimmed to match. That's not pedantry —
    ffmpeg hands back a few samples more or fewer than ``duration × rate``
    depending on where the codec's frame boundaries fall, and left uncorrected
    that error compounds across every chunk until the back half of a long
    meeting is captioned seconds off.
    """
    chunk_dir = work_dir / f"chunk{index:04d}"
    out_dir = chunk_dir / "out"
    out_dir.mkdir(parents=True, exist_ok=True)

    lead = min(LEAD_IN_SEC, start)
    src = chunk_dir / "in.wav"
    written = _decode_window(
        audio_path,
        src,
        start - lead,
        None if duration is None else duration + lead,
    )

    cmd = [BIN, "-D", "--atten-lim-db", str(ATTEN_LIM_DB), "-o", str(out_dir)]
    if POST_FILTER:
        cmd.append("--pf")
    cmd.append(str(src))
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, check=True)

    _, denoised = wavfile.read(out_dir / "in.wav")

    # `-D` aligns output sample i with input sample i but drops the final ~30 ms
    # that never left the lookahead buffer. Restore the exact length so the
    # chunk still covers the span of the timeline it was cut from.
    audio = _fit(denoised, written).astype(np.float32) / 32768.0
    audio = audio[round(lead * DF_SAMPLE_RATE):]

    # Free the wavs as we go: a long meeting is many hundreds of MB at 48 kHz.
    shutil.rmtree(chunk_dir, ignore_errors=True)

    # 48000 → 16000 is an exact 1:3 decimation, so resample_poly filters and
    # downsamples in one pass without any resampling error to speak of.
    out = resample_poly(audio, TARGET_SAMPLE_RATE, DF_SAMPLE_RATE).astype(np.float32)
    return out if expected is None else _fit(out, expected)


def denoise(audio_path: str) -> Optional[np.ndarray]:
    """Return ``audio_path`` denoised, as 16 kHz mono float32.

    Returns None — meaning "fall back to decoding the original" — whenever
    denoising is off, the binary is missing, or anything at all goes wrong.
    Noise suppression is an enhancement; losing it must never cost the user
    their transcription, so every failure path here is non-fatal.
    """
    if not is_available():
        reason = unavailable_reason()
        if ENABLED:
            print(f"[denoise] {reason} Using original audio.")
        return None

    duration = _probe_duration(audio_path)

    # Windows to process: one per CHUNK_SEC, as
    # ``(start_sec, duration_sec, expected_16k_samples)``. Boundaries are laid
    # out in samples rather than seconds so the pieces tile the timeline exactly
    # — chunk *i* owns samples ``[i·N, (i+1)·N)`` and nothing else, no matter
    # what ffmpeg hands back. A short file (or one ffprobe couldn't measure)
    # becomes a single window with no length constraint at all.
    windows: List[tuple] = []
    if duration <= 0 or duration <= CHUNK_SEC:
        windows.append((0.0, None, None))
    else:
        total = round(duration * TARGET_SAMPLE_RATE)
        step = round(CHUNK_SEC * TARGET_SAMPLE_RATE)
        for begin in range(0, total, step):
            end = begin + step
            if end >= total:
                # ffprobe's duration is a container estimate and reads a little
                # short of what the decoder actually produces, so the last
                # window is left open-ended — capping it to `total` would lop
                # the final few milliseconds off the recording. Every earlier
                # window keeps its exact span, so nothing drifts.
                windows.append((begin / TARGET_SAMPLE_RATE, None, None))
                break
            windows.append((begin / TARGET_SAMPLE_RATE, CHUNK_SEC, step))

    work_dir = Path(tempfile.mkdtemp(prefix="deepfilter-"))
    try:
        if len(windows) == 1:
            parts = [_run_chunk(work_dir, 0, audio_path, *windows[0])]
        else:
            with ThreadPoolExecutor(max_workers=WORKERS) as pool:
                # The heavy lifting happens in a subprocess, so threads here are
                # only waiting on it — the GIL is irrelevant and chunks really
                # do run in parallel. map() preserves order, which matters:
                # these are concatenated back into a single timeline.
                parts = list(
                    pool.map(
                        lambda job: _run_chunk(work_dir, job[0], audio_path, *job[1]),
                        enumerate(windows),
                    )
                )

        audio = np.concatenate(parts) if len(parts) > 1 else parts[0]
    except Exception as exc:  # noqa: BLE001 - never fail a transcription over denoising
        print(f"[denoise] DeepFilterNet failed, using original audio: {exc}")
        return None
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)

    if audio.size == 0:
        print("[denoise] produced empty audio; using original")
        return None

    print(
        f"[denoise] DeepFilterNet cleaned {len(audio) / TARGET_SAMPLE_RATE:.1f}s "
        f"in {len(windows)} chunk(s)"
    )
    return audio
