import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from faster_whisper import WhisperModel

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
    suffix = Path(upload_file.filename).suffix or ".wav"
    temp_file = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        temp_file.write(upload_file.file.read())
    finally:
        temp_file.close()
    return temp_file.name


def diarize_audio(audio_path: str) -> List[Dict[str, Any]]:
    try:
        import pynote
    except ImportError:
        return []

    if hasattr(pynote, "diarize"):
        result = pynote.diarize(audio_path)
        if isinstance(result, list):
            return result

    return []


def build_default_speaker_segments(raw_segments: Any) -> List[Dict[str, Any]]:
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


@app.post("/transcribe", response_model=TranscriptionResponse)
async def transcribe(file: UploadFile = File(...)):
    if not file.content_type.startswith("audio/"):
        raise HTTPException(status_code=400, detail="Upload a valid audio file.")

    temp_path = save_upload(file)
    try:
        segments, info = model.transcribe(
            temp_path,
            beam_size=5,
            language="en",
            condition_on_previous_text=False,
            word_timestamps=True,
        )

        raw_segments = list(segments)
        transcript_parts: List[str] = []
        for segment in raw_segments:
            text = getattr(segment, "text", "").strip()
            if text:
                transcript_parts.append(text)

        speaker_segments = diarize_audio(temp_path)
        if not speaker_segments:
            speaker_segments = build_default_speaker_segments(raw_segments)

        return TranscriptionResponse(
            transcript=" ".join(transcript_parts).strip(),
            segments=[SpeakerSegment(**segment) for segment in speaker_segments],
            language=getattr(info, "language", "unknown"),
            duration=float(getattr(info, "duration", 0.0)) if hasattr(info, "duration") else None,
        )
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass
