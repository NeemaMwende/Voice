"""Speaker diarization via pyannote/speaker-diarization-3.1.

Kept separate from transcription (main.py). Whisper produces the words;
this module tells us *who* was speaking during each slice of time, and
main.py stitches the two together.

Requires:
  * `pip install pyannote.audio torch torchaudio`
  * Accepting the model terms at
    https://huggingface.co/pyannote/speaker-diarization-3.1
  * A Hugging Face token exported as HF_TOKEN (or HUGGINGFACE_TOKEN).
"""

from __future__ import annotations

import os
import subprocess
from typing import Dict, List, Optional, Tuple

MODEL_ID = os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-3.1")

# pyannote ingests 16 kHz mono audio. We decode to that ourselves (below).
DIARIZE_SR = 16000

# Lazily initialised so the (heavy) model only loads on first use, and a
# missing token / package doesn't crash the whole API at import time.
_pipeline = None
_load_error: Optional[str] = None
_loaded = False


class DiarizationUnavailable(RuntimeError):
    """Raised when the diarization pipeline can't be loaded or run."""


def _load_pipeline() -> None:
    global _pipeline, _load_error, _loaded
    if _loaded:
        return
    _loaded = True

    try:
        import torch
        from pyannote.audio import Pipeline
    except ImportError as exc:  # pragma: no cover - env dependent
        _load_error = (
            "pyannote.audio / torch not installed. Run "
            "`pip install pyannote.audio torch torchaudio`. "
            f"({exc})"
        )
        return

    token = os.environ.get("HF_TOKEN")
    if not token:
        _load_error = (
            "HF_TOKEN not set. Accept the terms at "
            f"https://huggingface.co/{MODEL_ID} and export HF_TOKEN=<your token>."
        )
        return

    try:
        # pyannote.audio >= 3.3 takes `token=`; older releases used
        # `use_auth_token=`. Try the modern name first, fall back for old envs.
        try:
            pipeline = Pipeline.from_pretrained(MODEL_ID, token=token)
        except TypeError:
            pipeline = Pipeline.from_pretrained(MODEL_ID, use_auth_token=token)
    except Exception as exc:  # noqa: BLE001 - surface any load failure as text
        _load_error = f"Could not load '{MODEL_ID}': {exc}"
        return

    # Use the GPU when available; pyannote runs on CPU otherwise (slower).
    try:
        if torch.cuda.is_available():
            pipeline.to(torch.device("cuda"))
    except Exception:  # noqa: BLE001 - device move is best-effort
        pass

    _pipeline = pipeline


def is_available() -> bool:
    _load_pipeline()
    return _pipeline is not None


def unavailable_reason() -> Optional[str]:
    _load_pipeline()
    return _load_error


def _load_waveform(audio_path: str):
    """Decode any audio file to an in-memory 16 kHz mono waveform via ffmpeg.

    pyannote 4.x decodes audio through torchcodec, which fails on some
    containers/codecs ("Invalid data found when processing input"). Decoding
    ourselves with ffmpeg and handing pyannote a ``{"waveform", "sample_rate"}``
    dict sidesteps torchcodec entirely and accepts anything ffmpeg can read.
    """
    import numpy as np
    import torch

    cmd = [
        "ffmpeg", "-nostdin", "-threads", "1",
        "-i", audio_path,
        "-f", "f32le", "-acodec", "pcm_f32le",
        "-ac", "1", "-ar", str(DIARIZE_SR),
        "-",
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
    audio = np.frombuffer(proc.stdout, dtype=np.float32).copy()
    waveform = torch.from_numpy(audio).unsqueeze(0)  # shape: (1 channel, samples)
    return {"waveform": waveform, "sample_rate": DIARIZE_SR}


def diarize(
    audio_path: str,
    num_speakers: Optional[int] = None,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
) -> Tuple[List[Dict[str, object]], List[Dict[str, float]]]:
    """Return ``(turns, overlaps)``.

    ``turns``: ``[{"start", "end", "speaker"}]`` sorted by start.
    ``overlaps``: ``[{"start", "end"}]`` — time ranges where pyannote detected
    two speakers talking at once (crosstalk), best-effort; empty if the
    pipeline didn't emit overlapping regions.

    When the number of speakers is known (e.g. a 2-person interview), pass
    ``num_speakers`` — pyannote otherwise estimates it and can over-split a
    single voice into many phantom speakers. ``min_speakers`` / ``max_speakers``
    bound the estimate when the exact count isn't known.

    Raises DiarizationUnavailable if the pipeline can't be loaded/run.
    """
    _load_pipeline()
    if _pipeline is None:
        raise DiarizationUnavailable(_load_error or "Diarization pipeline unavailable.")

    params: Dict[str, int] = {}
    if num_speakers and num_speakers > 0:
        params["num_speakers"] = int(num_speakers)
    else:
        if min_speakers and min_speakers > 0:
            params["min_speakers"] = int(min_speakers)
        if max_speakers and max_speakers > 0:
            params["max_speakers"] = int(max_speakers)

    # Prefer decoding via ffmpeg (robust); fall back to letting pyannote read
    # the path directly if ffmpeg isn't available.
    try:
        audio_input: object = _load_waveform(audio_path)
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        print(f"[diarization] ffmpeg decode failed, using path directly: {exc}")
        audio_input = audio_path

    try:
        output = _pipeline(audio_input, **params)
    except Exception as exc:  # noqa: BLE001
        raise DiarizationUnavailable(f"Diarization failed: {exc}") from exc

    # pyannote 4.x returns a DiarizeOutput wrapper; 3.x returned the Annotation
    # directly. Prefer the non-overlapping ("exclusive") track for clean
    # word-to-speaker alignment.
    annotation = getattr(output, "exclusive_speaker_diarization", None)
    if annotation is None:
        annotation = getattr(output, "speaker_diarization", output)

    turns: List[Dict[str, object]] = []
    for segment, _, speaker in annotation.itertracks(yield_label=True):
        turns.append(
            {
                "start": float(segment.start),
                "end": float(segment.end),
                "speaker": str(speaker),
            }
        )
    turns.sort(key=lambda t: t["start"])

    # Crosstalk regions: time ranges where ≥2 speakers were active at once.
    # On pyannote 3.x (installed: 3.2.0) the pipeline returns an Annotation
    # directly, and Annotation.get_overlap() yields the intersections. On 4.x
    # the exclusive track is non-overlapping by construction, so this comes
    # back empty — the full ``speaker_diarization`` track would be the source
    # there. Best-effort: never let overlap computation break diarization.
    overlaps: List[Dict[str, float]] = []
    try:
        for segment in annotation.get_overlap():
            overlaps.append({"start": float(segment.start), "end": float(segment.end)})
    except Exception as exc:  # noqa: BLE001
        print(f"[diarization] overlap computation skipped: {exc}")

    return turns, overlaps
