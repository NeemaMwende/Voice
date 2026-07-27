"""EchoNotes transcription backend.

Whisper (faster-whisper) does the transcription with word-level timestamps;
pyannote (see diarization.py) says who was speaking when. We overlap the two
so every word is attributed to a speaker, then merge consecutive same-speaker
words into readable turns.
"""

import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from faster_whisper import WhisperModel

import diarization

app = FastAPI(title="EchoNotes Transcription Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MODEL_NAME = os.environ.get("MODEL_NAME", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")
# Force a language (e.g. "en") or leave unset for auto-detection.
LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None

model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE)


class SpeakerSegment(BaseModel):
    speaker: str
    start: float
    end: float
    text: str


class TranscriptionResponse(BaseModel):
    transcript: str
    segments: List[SpeakerSegment]
    language: str
    duration: Optional[float] = None


def save_upload(upload_file: UploadFile) -> str:
    suffix = Path(upload_file.filename or "audio").suffix or ".wav"
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        temp_file.write(upload_file.file.read())
    finally:
        temp_file.close()
    return temp_file.name


def flatten_words(raw_segments: List[Any]) -> List[Dict[str, Any]]:
    """Collect word-level timings; fall back to segment-level if unavailable."""
    words: List[Dict[str, Any]] = []
    for segment in raw_segments:
        seg_words = getattr(segment, "words", None)
        if seg_words:
            for word in seg_words:
                text = getattr(word, "word", "")
                if not text:
                    continue
                words.append(
                    {
                        "start": float(getattr(word, "start", 0.0) or 0.0),
                        "end": float(getattr(word, "end", 0.0) or 0.0),
                        "text": text,
                    }
                )
        else:
            text = getattr(segment, "text", "")
            if text:
                words.append(
                    {
                        "start": float(getattr(segment, "start", 0.0) or 0.0),
                        "end": float(getattr(segment, "end", 0.0) or 0.0),
                        "text": text,
                    }
                )
    return words


def speaker_at(start: float, end: float, turns: List[Dict[str, Any]]) -> Optional[str]:
    """Speaker whose turn overlaps [start, end] the most; nearest if none overlap."""
    best_speaker: Optional[str] = None
    best_overlap = 0.0
    for turn in turns:
        overlap = min(end, turn["end"]) - max(start, turn["start"])
        if overlap > best_overlap:
            best_overlap = overlap
            best_speaker = turn["speaker"]
    if best_speaker is not None:
        return best_speaker

    # No overlap (word sits in a gap) → attach to the temporally nearest turn.
    if turns:
        mid = (start + end) / 2.0
        nearest = min(turns, key=lambda t: abs(((t["start"] + t["end"]) / 2.0) - mid))
        return nearest["speaker"]
    return None


def merge_words_with_speakers(
    words: List[Dict[str, Any]], turns: List[Dict[str, Any]]
) -> List[Dict[str, Any]]:
    """Attribute each word to a speaker and merge consecutive same-speaker words."""
    label_map: Dict[str, str] = {}

    def friendly(raw_label: Optional[str]) -> str:
        key = raw_label or "SPEAKER"
        if key not in label_map:
            label_map[key] = f"Speaker {len(label_map) + 1}"
        return label_map[key]

    segments: List[Dict[str, Any]] = []
    for word in words:
        speaker = friendly(speaker_at(word["start"], word["end"], turns))
        if segments and segments[-1]["speaker"] == speaker:
            segments[-1]["text"] += word["text"]
            segments[-1]["end"] = word["end"]
        else:
            segments.append(
                {
                    "speaker": speaker,
                    "start": word["start"],
                    "end": word["end"],
                    "text": word["text"],
                }
            )

    for seg in segments:
        seg["text"] = seg["text"].strip()
    return [seg for seg in segments if seg["text"]]


def build_default_speaker_segments(raw_segments: List[Any]) -> List[Dict[str, Any]]:
    """Fallback grouping (single/gap-based) when diarization is unavailable."""
    result: List[Dict[str, Any]] = []
    current_speaker = 1
    previous_end = 0.0

    for segment in raw_segments:
        text = getattr(segment, "text", "").strip()
        if not text:
            continue
        start = float(getattr(segment, "start", 0.0))
        end = float(getattr(segment, "end", start))
        if start - previous_end > 3.0 and len(result) > 0:
            current_speaker += 1
        result.append(
            {
                "speaker": f"Speaker {current_speaker}",
                "start": start,
                "end": end,
                "text": text,
            }
        )
        previous_end = end
    return result


@app.get("/health")
def health():
    return {
        "status": "ok",
        "whisper_model": MODEL_NAME,
        "device": DEVICE,
        "diarization_available": diarization.is_available(),
        "diarization_note": diarization.unavailable_reason(),
    }


@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe(file: UploadFile = File(...)):
    if not (file.content_type or "").startswith("audio/"):
        raise HTTPException(status_code=400, detail="Upload a valid audio file.")

    temp_path = save_upload(file)
    try:
        segments, info = model.transcribe(
            temp_path,
            beam_size=5,
            language=LANGUAGE,
            condition_on_previous_text=False,
            word_timestamps=True,
        )
        raw_segments = list(segments)

        transcript = " ".join(
            getattr(s, "text", "").strip() for s in raw_segments if getattr(s, "text", "").strip()
        ).strip()

        # Diarize + merge; fall back to gap-based grouping if pyannote is unavailable.
        try:
            turns = diarization.diarize(temp_path)
        except diarization.DiarizationUnavailable as exc:
            print(f"[diarization] unavailable: {exc}")
            turns = []

        if turns:
            words = flatten_words(raw_segments)
            speaker_segments = merge_words_with_speakers(words, turns)
        else:
            speaker_segments = build_default_speaker_segments(raw_segments)

        return TranscriptionResponse(
            transcript=transcript,
            segments=[SpeakerSegment(**segment) for segment in speaker_segments],
            language=getattr(info, "language", "unknown"),
            duration=float(getattr(info, "duration", 0.0)) if hasattr(info, "duration") else None,
        )
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host=host, port=port)
