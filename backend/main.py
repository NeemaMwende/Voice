"""EchoNotes transcription backend.

Whisper (faster-whisper) does the transcription with word-level timestamps;
pyannote (see diarization.py) says who was speaking when. We overlap the two
so every word is attributed to a speaker, then merge consecutive same-speaker
words into readable turns.
"""

import os
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv

load_dotenv()  # read backend/.env (HF_TOKEN, OLLAMA_URL, OLLAMA_MODEL, PG_*, …)

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from faster_whisper import WhisperModel

import diarization
import progress
import summarization
import db

# When one speaker holds the floor, keep their words in a single block instead
# of one bubble per Whisper segment. A pause longer than this (seconds) inside
# that block becomes a paragraph break so long turns stay readable.
PARAGRAPH_GAP_SEC = float(os.environ.get("PARAGRAPH_GAP_SEC", "2.0"))

# Uploaded audio is kept here so playback survives a page reload (object URLs
# don't). Served read-only under /media (StaticFiles handles range requests).
MEDIA_DIR = Path(os.environ.get("MEDIA_DIR", "media"))
MEDIA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="EchoNotes Transcription Backend")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.mount("/media", StaticFiles(directory=str(MEDIA_DIR)), name="media")


@app.on_event("startup")
def _startup() -> None:
    try:
        db.init_db()
        print("[db] recordings table ready")
    except Exception as exc:  # noqa: BLE001 - keep transcription usable if DB is down
        print(f"[db] init failed (persistence disabled): {exc}")

MODEL_NAME = os.environ.get("MODEL_NAME", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
COMPUTE_TYPE = os.environ.get("WHISPER_COMPUTE", "int8")
# Force a language (e.g. "en") or leave unset for auto-detection.
LANGUAGE = os.environ.get("WHISPER_LANGUAGE") or None

# Whisper tuning. Diarization dominates runtime, so Whisper is tuned for
# completeness/accuracy — its cost is negligible next to pyannote.
#  * WHISPER_BEAM=5 (beam search) for accuracy; set 1 for greedy/faster.
#  * WHISPER_VAD is OFF by default: the voice-activity filter drops anything it
#    judges non-speech, which silently truncates transcripts (badly on music and
#    quiet speech) and strips filler words. We want the FULL raw transcript, so
#    only enable it (WHISPER_VAD=1) for clean single-speaker speech where speed
#    matters more than capturing every word.
#  * WHISPER_THREADS=0 lets faster-whisper pick; set e.g. 8 to cap CPU use.
BEAM_SIZE = int(os.environ.get("WHISPER_BEAM", "5"))
USE_VAD = os.environ.get("WHISPER_VAD", "0") in ("1", "true", "True")
CPU_THREADS = int(os.environ.get("WHISPER_THREADS", "0"))

model = WhisperModel(
    MODEL_NAME,
    device=DEVICE,
    compute_type=COMPUTE_TYPE,
    cpu_threads=CPU_THREADS,
)


class SpeakerSegment(BaseModel):
    speaker: str
    start: float
    end: float
    text: str


class NoteSection(BaseModel):
    heading: str
    bullets: List[str] = []


class TranscriptionResponse(BaseModel):
    transcript: str
    segments: List[SpeakerSegment]
    language: str
    duration: Optional[float] = None
    summary: Optional[str] = None
    key_points: List[str] = []
    action_items: List[str] = []
    insights: List[NoteSection] = []
    outline: List[NoteSection] = []
    audio_url: Optional[str] = None


def save_upload(upload_file: UploadFile) -> tuple[str, str]:
    """Persist the upload under MEDIA_DIR. Returns (disk_path, media_url).

    The file is kept (not deleted) so it can be replayed after a reload; the
    media_url is a durable ``/media/<name>`` path the frontend stores.
    """
    suffix = Path(upload_file.filename or "audio").suffix or ".wav"
    media_name = f"{uuid.uuid4().hex}{suffix}"
    dest = MEDIA_DIR / media_name
    with open(dest, "wb") as out:
        out.write(upload_file.file.read())
    return str(dest), f"/media/{media_name}"


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


def consolidate_segments(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Merge consecutive same-speaker segments into one block.

    A speaker who holds the floor for a while should read as a single turn, not
    a stack of one-line bubbles. Consecutive segments from the same speaker are
    joined together; a longer pause between them becomes a paragraph break so a
    long turn stays readable. A new block only starts when a *different* speaker
    takes over.
    """
    consolidated: List[Dict[str, Any]] = []
    for segment in segments:
        text = (segment.get("text") or "").strip()
        if not text:
            continue

        prev = consolidated[-1] if consolidated else None
        if prev is not None and prev["speaker"] == segment["speaker"]:
            gap = float(segment["start"]) - float(prev["end"])
            joiner = "\n\n" if gap > PARAGRAPH_GAP_SEC else " "
            prev["text"] = f"{prev['text']}{joiner}{text}"
            prev["end"] = float(segment["end"])
        else:
            consolidated.append(
                {
                    "speaker": segment["speaker"],
                    "start": float(segment["start"]),
                    "end": float(segment["end"]),
                    "text": text,
                }
            )
    return consolidated


def build_default_speaker_segments(raw_segments: List[Any]) -> List[Dict[str, Any]]:
    """Fallback used when diarization is unavailable.

    Without diarization we genuinely cannot tell voices apart from the audio, so
    inventing a new ``Speaker N`` on every pause is wrong — it turns one person
    into dozens of phantom speakers. Instead attribute everything to a single
    speaker; ``consolidate_segments`` then stitches it into readable paragraphs.
    """
    result: List[Dict[str, Any]] = []
    for segment in raw_segments:
        text = getattr(segment, "text", "").strip()
        if not text:
            continue
        start = float(getattr(segment, "start", 0.0))
        end = float(getattr(segment, "end", start))
        result.append(
            {
                "speaker": "Speaker 1",
                "start": start,
                "end": end,
                "text": text,
            }
        )
    return result


def labeled_transcript(segments: List[Dict[str, Any]]) -> str:
    """``Speaker 1: …`` transcript — what the summarizer and namer both read."""
    return "\n\n".join(f"{seg['speaker']}: {seg['text']}" for seg in segments)


def apply_speaker_names(segments: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Rename ``Speaker N`` labels to real names when the talk reveals them.

    People introduce themselves and address each other by name, so a diarized
    transcript usually carries enough to label the voices properly. Anyone whose
    name is never said keeps their ``Speaker N`` fallback.
    """
    labels: List[str] = []
    for seg in segments:
        if seg["speaker"] not in labels:
            labels.append(seg["speaker"])
    if not labels:
        return segments

    try:
        names = summarization.identify_speakers(labeled_transcript(segments), labels)
    except Exception as exc:  # noqa: BLE001 - naming is a nicety, never fatal
        print(f"[speakers] name detection failed: {exc}")
        return segments

    if names:
        print(f"[speakers] resolved {names}")
    for seg in segments:
        seg["speaker"] = names.get(seg["speaker"], seg["speaker"])
    return segments


@app.get("/health")
def health():
    return {
        "status": "ok",
        "whisper_model": MODEL_NAME,
        "device": DEVICE,
        "diarization_available": diarization.is_available(),
        "diarization_note": diarization.unavailable_reason(),
    }


@app.get("/progress/{job_id}")
def transcription_progress(job_id: str) -> Dict[str, Any]:
    """Live progress for an in-flight /transcribe call. See progress.py."""
    return progress.get(job_id)


# Defined with `def` (not `async def`) on purpose: the work below is blocking
# CPU work, so FastAPI runs it in a worker thread and the /progress endpoint
# stays responsive while a transcription is underway.
@app.post("/transcribe", response_model=TranscriptionResponse)
def transcribe(
    file: UploadFile = File(...),
    num_speakers: Optional[int] = Form(None),
    job_id: Optional[str] = Form(None),
):
    if not (file.content_type or "").startswith("audio/"):
        raise HTTPException(status_code=400, detail="Upload a valid audio file.")

    progress.start(job_id)
    try:
        return _run_transcription(file, num_speakers, job_id)
    except Exception:
        progress.finish(job_id, failed=True)
        raise


def _run_transcription(
    file: UploadFile, num_speakers: Optional[int], job_id: Optional[str]
) -> TranscriptionResponse:
    audio_path, audio_url = save_upload(file)
    progress.update(job_id, 12, "uploading", "Saving audio")

    segments, info = model.transcribe(
        audio_path,
        beam_size=BEAM_SIZE,
        language=LANGUAGE,
        condition_on_previous_text=False,
        word_timestamps=True,
        vad_filter=USE_VAD,
    )

    # faster-whisper streams segments lazily, so draining the generator here
    # gives us genuine transcription progress: how far into the audio we are.
    total_sec = float(getattr(info, "duration", 0.0) or 0.0)
    raw_segments = []
    for segment in segments:
        raw_segments.append(segment)
        if total_sec > 0:
            done = min(1.0, float(getattr(segment, "end", 0.0) or 0.0) / total_sec)
            progress.update(job_id, 15 + 45 * done, "transcribing", "Transcribing audio")

    transcript = " ".join(
        getattr(s, "text", "").strip() for s in raw_segments if getattr(s, "text", "").strip()
    ).strip()

    # Diarize + merge; fall back to single-speaker grouping if unavailable.
    progress.update(job_id, 62, "diarizing", "Separating speakers")
    try:
        turns = diarization.diarize(audio_path, num_speakers=num_speakers)
    except diarization.DiarizationUnavailable as exc:
        print(f"[diarization] unavailable: {exc}")
        turns = []

    if turns:
        words = flatten_words(raw_segments)
        speaker_segments = merge_words_with_speakers(words, turns)
    else:
        speaker_segments = build_default_speaker_segments(raw_segments)

    # Collapse consecutive same-speaker turns into one consolidated block.
    speaker_segments = consolidate_segments(speaker_segments)

    # Swap Speaker 1/2 for real names wherever the conversation reveals them.
    progress.update(job_id, 76, "naming", "Identifying speakers")
    speaker_segments = apply_speaker_names(speaker_segments)

    # Summarize into the full note set (best-effort; never fatal). The
    # speaker-labelled transcript goes in so the notes can attribute by name.
    progress.update(job_id, 80, "analyzing", "Writing notes")
    summary_text: Optional[str] = None
    key_points: List[str] = []
    action_items: List[str] = []
    insights: List[Dict[str, Any]] = []
    outline: List[Dict[str, Any]] = []
    try:
        result = summarization.summarize(
            labeled_transcript(speaker_segments) or transcript,
            on_progress=lambda frac, label: progress.update(
                job_id, 80 + 18 * frac, "analyzing", label
            ),
        )
        summary_text = result["summary"] or None
        key_points = result["key_points"]
        action_items = result["action_items"]
        insights = result["insights"]
        outline = result["outline"]
    except summarization.SummaryUnavailable as exc:
        print(f"[summarization] unavailable: {exc}")

    progress.finish(job_id)
    return TranscriptionResponse(
        transcript=transcript,
        segments=[SpeakerSegment(**segment) for segment in speaker_segments],
        language=getattr(info, "language", "unknown"),
        duration=float(getattr(info, "duration", 0.0)) if hasattr(info, "duration") else None,
        summary=summary_text,
        key_points=key_points,
        action_items=action_items,
        insights=[NoteSection(**section) for section in insights],
        outline=[NoteSection(**section) for section in outline],
        audio_url=audio_url,
    )


# ---------------------------------------------------------------------------
# Recording persistence (PostgreSQL). These let the frontend save results and
# reload them after a refresh instead of losing everything from memory.
# ---------------------------------------------------------------------------


@app.get("/recordings")
def list_recordings() -> List[Dict[str, Any]]:
    """All saved recordings, newest first."""
    with db.SessionLocal() as session:
        rows = (
            session.query(db.Recording)
            .order_by(db.Recording.created_at.desc())
            .all()
        )
        return [row.to_dict() for row in rows]


@app.get("/recordings/{recording_id}")
def get_recording(recording_id: str) -> Dict[str, Any]:
    with db.SessionLocal() as session:
        row = session.get(db.Recording, recording_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Recording not found.")
        return row.to_dict()


@app.post("/recordings")
def create_recording(payload: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Insert (or replace) a recording. Idempotent on id so re-saves are safe."""
    if not payload.get("id"):
        raise HTTPException(status_code=400, detail="Recording 'id' is required.")
    with db.SessionLocal() as session:
        existing = session.get(db.Recording, str(payload["id"]))
        if existing is not None:
            session.delete(existing)
            session.flush()
        row = db.Recording.from_dict(payload)
        session.add(row)
        session.commit()
        return row.to_dict()


@app.delete("/recordings/{recording_id}")
def delete_recording(recording_id: str) -> Dict[str, Any]:
    with db.SessionLocal() as session:
        row = session.get(db.Recording, recording_id)
        if row is None:
            raise HTTPException(status_code=404, detail="Recording not found.")
        audio_url = row.audio_url or ""
        session.delete(row)
        session.commit()

    # Best-effort cleanup of the stored audio file.
    if audio_url.startswith("/media/"):
        media_file = MEDIA_DIR / Path(audio_url).name
        try:
            media_file.unlink(missing_ok=True)
        except OSError as exc:  # noqa: BLE001
            print(f"[media] could not delete {media_file}: {exc}")

    return {"status": "deleted", "id": recording_id}


if __name__ == "__main__":
    import uvicorn

    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host=host, port=port)
