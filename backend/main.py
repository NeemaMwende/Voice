"""DAXA transcription backend.

Whisper (faster-whisper) does the transcription with word-level timestamps;
pyannote (see diarization.py) says who was speaking when. We overlap the two
so every word is attributed to a speaker, then merge consecutive same-speaker
words into readable turns.
"""

import os

# Fix MKL memory issue on Windows — must be set before numpy/torch imports
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ["MKL_THREADING_LAYER"] = "sequential"

import asyncio
import concurrent.futures
import subprocess
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

from dotenv import load_dotenv

load_dotenv()  # read backend/.env (HF_TOKEN, OLLAMA_URL, OLLAMA_MODEL, PG_*, …)

from fastapi import Body, Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from faster_whisper import WhisperModel

import auth
import diarization
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

app = FastAPI(title="DAXA Transcription Backend")

# Locked to the frontend origins instead of "*" now that the API carries auth.
FRONTEND_ORIGINS = [
    origin.strip()
    for origin in os.environ.get(
        "FRONTEND_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3007,http://127.0.0.1:3007",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
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

# Progress tracking for polling-based progress bar
_progress_store: Dict[str, dict] = {}
_inference_executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)


class Word(BaseModel):
    """One transcribed word with the model's self-reported probability.

    ``p`` is faster-whisper's per-word probability — the model's *certainty*,
    not verified accuracy. None means the value wasn't produced (e.g. the
    segment-level fallback path).
    """

    start: float
    end: float
    text: str
    p: Optional[float] = None


class Overlap(BaseModel):
    """Time range where diarization detected two speakers talking at once."""

    start: float
    end: float


class SpeakerSegment(BaseModel):
    speaker: str
    start: float
    end: float
    text: str
    confidence: Optional[float] = None  # mean of per-word p; None = unknown
    words: Optional[List[Word]] = None


class TranscriptionResponse(BaseModel):
    transcript: str
    segments: List[SpeakerSegment]
    language: str
    duration: Optional[float] = None
    summary: Optional[str] = None
    key_points: List[str] = []
    audio_url: Optional[str] = None
    overlaps: List[Overlap] = []
    peaks: Optional[List[float]] = None  # amplitude envelope (0..1), ~1000 buckets


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


def compute_peaks(audio_path: str, buckets: int = 1000) -> Optional[List[float]]:
    """Amplitude envelope (0..1) for a waveform visual.

    Decodes with ffmpeg to 4 kHz mono s16 — 4 kHz is plenty for a visual
    envelope and keeps even a 1-hour file to ~28 MB in memory. Bucket-wise
    peak amplitude, normalized to the loudest bucket. Best-effort: returns
    None on any failure so the UI can fall back to speaker lanes only.
    """
    try:
        proc = subprocess.run(
            [
                "ffmpeg", "-nostdin", "-threads", "1",
                "-i", audio_path,
                "-f", "s16le", "-acodec", "pcm_s16le",
                "-ac", "1", "-ar", "4000",
                "-",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=300,
        )
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        print(f"[peaks] ffmpeg decode failed, skipping peaks: {exc}")
        return None

    samples = np.frombuffer(proc.stdout, dtype=np.int16)
    if samples.size == 0:
        return None
    env = np.abs(samples.astype(np.float32)) / 32768.0
    chunk = max(1, env.size // buckets)
    n = env.size // chunk
    if n == 0:
        return [round(float(env.max()), 4)]
    trimmed = env[: n * chunk].reshape(n, chunk).max(axis=1)
    peak = float(trimmed.max()) or 1.0
    return [round(float(v / peak), 4) for v in trimmed]


def mean_confidence(words: List[Dict[str, Any]]) -> Optional[float]:
    """Mean of the known per-word probabilities; None if none are known."""
    probs = [w["p"] for w in words if w.get("p") is not None]
    return round(sum(probs) / len(probs), 4) if probs else None


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
                p = getattr(word, "probability", None)
                words.append(
                    {
                        "start": float(getattr(word, "start", 0.0) or 0.0),
                        "end": float(getattr(word, "end", 0.0) or 0.0),
                        "text": text,
                        "p": float(p) if p is not None else None,
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
                        "p": None,
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
            segments[-1]["words"].append(word)
        else:
            segments.append(
                {
                    "speaker": speaker,
                    "start": word["start"],
                    "end": word["end"],
                    "text": word["text"],
                    "words": [word],
                    "confidence": None,
                }
            )

    for seg in segments:
        seg["text"] = seg["text"].strip()
        seg["confidence"] = mean_confidence(seg["words"])
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
            prev["words"] = (prev.get("words") or []) + (segment.get("words") or []) or None
            prev["confidence"] = mean_confidence(prev["words"])
        else:
            consolidated.append(
                {
                    "speaker": segment["speaker"],
                    "start": float(segment["start"]),
                    "end": float(segment["end"]),
                    "text": text,
                    "words": segment.get("words") or None,
                    "confidence": segment.get("confidence"),
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
        seg_words: List[Dict[str, Any]] = []
        for word in getattr(segment, "words", None) or []:
            w_text = getattr(word, "word", "")
            if not w_text:
                continue
            p = getattr(word, "probability", None)
            seg_words.append(
                {
                    "start": float(getattr(word, "start", 0.0) or 0.0),
                    "end": float(getattr(word, "end", 0.0) or 0.0),
                    "text": w_text,
                    "p": float(p) if p is not None else None,
                }
            )
        result.append(
            {
                "speaker": "Speaker 1",
                "start": start,
                "end": end,
                "text": text,
                "words": seg_words or None,
                "confidence": mean_confidence(seg_words),
            }
        )
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


def _transcribe_with_progress(
    audio_path: str,
    num_speakers: Optional[int],
    audio_url: str,
    progress_id: str,
    hotwords: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Run full transcription pipeline in a background thread, reporting progress."""
    try:
        _progress_store[progress_id] = {"pct": 1, "status": "transcribing"}

        # Amplitude envelope for the waveform visual — cheap ffmpeg pass,
        # independent of whisper/diarization so it always works.
        peaks = compute_peaks(audio_path)

        segments, info = model.transcribe(
            audio_path,
            beam_size=BEAM_SIZE,
            language=LANGUAGE,
            condition_on_previous_text=False,
            word_timestamps=True,
            vad_filter=USE_VAD,
            hotwords=hotwords or None,
        )
        raw_segments: list[Any] = []
        for seg in segments:
            raw_segments.append(seg)
            total = max(float(info.duration) if hasattr(info, "duration") and info.duration else 1.0, float(seg.end))
            pct = min(int(seg.end / total * 100), 99)
            _progress_store[progress_id] = {"pct": pct, "status": "transcribing"}

        transcript = " ".join(
            getattr(s, "text", "").strip() for s in raw_segments if getattr(s, "text", "").strip()
        ).strip()

        # Emit phase transition so the frontend can show "Identifying speakers…"
        _progress_store[progress_id] = {"pct": 99, "status": "diarizing"}

        # Diarize + merge; fall back to single-speaker grouping if unavailable.
        overlaps: List[Dict[str, Any]] = []
        try:
            turns, overlaps = diarization.diarize(audio_path, num_speakers=num_speakers)
        except diarization.DiarizationUnavailable as exc:
            print(f"[diarization] unavailable: {exc}")
            turns = []

        if turns:
            words = flatten_words(raw_segments)
            speaker_segments = merge_words_with_speakers(words, turns)
        else:
            speaker_segments = build_default_speaker_segments(raw_segments)

        speaker_segments = consolidate_segments(speaker_segments)

        # Emit phase transition so the frontend can show "Summarizing…"
        _progress_store[progress_id] = {"pct": 99, "status": "summarizing"}

        # Summarize (best-effort).
        summary_text: Optional[str] = None
        key_points: List[str] = []
        try:
            result = summarization.summarize(transcript)
            summary_text = result["summary"] or None
            key_points = result["key_points"]
        except summarization.SummaryUnavailable as exc:
            print(f"[summarization] unavailable: {exc}")

        response = TranscriptionResponse(
            transcript=transcript,
            segments=[SpeakerSegment(**segment) for segment in speaker_segments],
            language=getattr(info, "language", "unknown"),
            duration=float(getattr(info, "duration", 0.0)) if hasattr(info, "duration") and info.duration else None,
            summary=summary_text,
            key_points=key_points,
            audio_url=audio_url,
            overlaps=[Overlap(**overlap) for overlap in overlaps],
            peaks=peaks,
        )

        _progress_store[progress_id] = {"pct": 100, "status": "complete", "result": response.model_dump()}
        # TTL eviction: clean up 5 minutes after completion (safer than delete-on-read
        # which races under React StrictMode or concurrent poll calls)
        threading.Timer(300, _progress_store.pop, args=[progress_id, None]).start()
        return None
    except Exception as exc:
        _progress_store[progress_id] = {"pct": 0, "status": "error", "error": str(exc)}
        threading.Timer(300, _progress_store.pop, args=[progress_id, None]).start()
        return None


@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    num_speakers: Optional[int] = Form(None),
    hotwords: Optional[str] = Form(None),
):
    if not (file.content_type or "").startswith("audio/"):
        raise HTTPException(status_code=400, detail="Upload a valid audio file.")

    audio_path, audio_url = save_upload(file)
    progress_id = str(uuid.uuid4())
    _progress_store[progress_id] = {"pct": 0, "status": "queued"}

    loop = asyncio.get_event_loop()
    loop.run_in_executor(
        _inference_executor,
        _transcribe_with_progress,
        audio_path,
        num_speakers,
        audio_url,
        progress_id,
        hotwords,
    )

    return {"progress_id": progress_id}


@app.get("/transcribe/progress/{progress_id}")
async def get_progress(progress_id: str):
    entry = _progress_store.get(progress_id)
    if entry is None:
        return {"pct": 0, "status": "unknown"}
    return entry


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
def create_recording(
    payload: Dict[str, Any] = Body(...),
    _user: dict = Depends(auth.get_current_user),
) -> Dict[str, Any]:
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
def delete_recording(
    recording_id: str,
    _user: dict = Depends(auth.get_current_user),
) -> Dict[str, Any]:
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
