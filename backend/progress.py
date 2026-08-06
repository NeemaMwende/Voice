"""In-memory progress registry for long-running transcription jobs.

/transcribe is a single blocking request that can take minutes (Whisper, then
pyannote, then a local LLM). The client generates a job id, sends it with the
upload, and polls /progress/<job_id> so the progress bar reflects what the
server is genuinely doing instead of a hard-coded guess.

State is per-process and deliberately ephemeral — a job that nobody polls is
evicted once the table grows past MAX_JOBS.
"""

from __future__ import annotations

import threading
from typing import Dict, Optional

MAX_JOBS = 64

_lock = threading.Lock()
_jobs: "Dict[str, Dict[str, object]]" = {}
_order: list[str] = []


def start(job_id: Optional[str]) -> None:
    if not job_id:
        return
    with _lock:
        _jobs[job_id] = {"pct": 10, "stage": "queued", "label": "Preparing…", "done": False}
        _order.append(job_id)
        while len(_order) > MAX_JOBS:
            _jobs.pop(_order.pop(0), None)


def update(job_id: Optional[str], pct: float, stage: str, label: str) -> None:
    """Record progress. Percent never moves backwards for a given job."""
    if not job_id:
        return
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        job["pct"] = max(int(job["pct"]), min(99, int(pct)))  # type: ignore[arg-type]
        job["stage"] = stage
        job["label"] = label


def finish(job_id: Optional[str], *, failed: bool = False) -> None:
    if not job_id:
        return
    with _lock:
        job = _jobs.get(job_id)
        if job is None:
            return
        job["pct"] = int(job["pct"]) if failed else 100  # type: ignore[arg-type]
        job["stage"] = "failed" if failed else "done"
        job["label"] = "Failed" if failed else "Complete"
        job["done"] = True


def get(job_id: str) -> Dict[str, object]:
    with _lock:
        job = _jobs.get(job_id)
        # An unknown id is normal: the client can poll before the upload lands.
        return dict(job) if job else {"pct": 0, "stage": "unknown", "label": "", "done": False}
