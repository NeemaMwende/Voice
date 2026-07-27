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
from typing import Dict, List, Optional

MODEL_ID = os.environ.get("DIARIZATION_MODEL", "pyannote/speaker-diarization-3.1")

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

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if not token:
        _load_error = (
            "HF_TOKEN not set. Accept the terms at "
            f"https://huggingface.co/{MODEL_ID} and export HF_TOKEN=<your token>."
        )
        return

    try:
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


def diarize(audio_path: str) -> List[Dict[str, object]]:
    """Return speaker turns as ``[{"start", "end", "speaker"}]`` sorted by start.

    Raises DiarizationUnavailable if the pipeline can't be loaded/run.
    """
    _load_pipeline()
    if _pipeline is None:
        raise DiarizationUnavailable(_load_error or "Diarization pipeline unavailable.")

    try:
        annotation = _pipeline(audio_path)
    except Exception as exc:  # noqa: BLE001
        raise DiarizationUnavailable(f"Diarization failed: {exc}") from exc

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
    return turns
