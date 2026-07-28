"""Transcript summarization via a local Ollama server.

Turns the raw transcript into an Otter-style overview plus a list of key points
/ action items. Long meetings are summarized map-reduce style: each chunk is
condensed to notes, then a final pass produces the structured summary.

Config (env / .env):
  * OLLAMA_URL   — base URL of the Ollama server (default http://localhost:11434)
  * OLLAMA_MODEL — model to use (default llama3.1:8b)
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Dict, List

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")

# Characters per map-reduce chunk. ~6k chars ≈ 1.5k tokens, comfortably inside
# the context window we request below with room for the prompt + output.
CHUNK_CHARS = 6000
NUM_CTX = 8192
REQUEST_TIMEOUT = 300  # seconds; local models can be slow on long inputs


class SummaryUnavailable(RuntimeError):
    """Raised when the Ollama server can't be reached or returns nothing usable."""


def _chat(system: str, user: str, *, as_json: bool = False) -> str:
    payload: Dict[str, object] = {
        "model": OLLAMA_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": False,
        "options": {"temperature": 0.2, "num_ctx": NUM_CTX},
    }
    if as_json:
        payload["format"] = "json"

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_URL}/api/chat",
        data=data,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            body = json.loads(resp.read())
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise SummaryUnavailable(f"Could not reach Ollama at {OLLAMA_URL}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise SummaryUnavailable(f"Ollama returned invalid JSON: {exc}") from exc

    return (body.get("message", {}) or {}).get("content", "").strip()


def _chunk(text: str, size: int) -> List[str]:
    """Split on paragraph/line boundaries so we don't cut mid-sentence."""
    chunks: List[str] = []
    current = ""
    for line in text.splitlines(keepends=True):
        if len(current) + len(line) > size and current:
            chunks.append(current)
            current = ""
        current += line
    if current.strip():
        chunks.append(current)
    return chunks or [text]


def _condense(chunk: str, index: int, total: int) -> str:
    system = (
        "You are a meeting-notes assistant. Condense this part of a transcript "
        "into terse bullet notes capturing decisions, topics discussed, questions "
        "raised, and any action items or commitments. Keep speaker intent. "
        "Reply with plain bullet lines only."
    )
    user = f"Transcript part {index} of {total}:\n\n{chunk}"
    return _chat(system, user)


def _is_meaningful(text: str) -> bool:
    return bool(text and len(text.split()) >= 3)


def summarize(transcript: str) -> Dict[str, object]:
    """Return ``{"summary": str, "key_points": [str, ...]}`` for a transcript.

    Raises SummaryUnavailable if the model can't produce a usable result.
    """
    transcript = (transcript or "").strip()
    if not _is_meaningful(transcript):
        raise SummaryUnavailable("Transcript too short to summarize.")

    chunks = _chunk(transcript, CHUNK_CHARS)
    if len(chunks) == 1:
        notes = transcript
    else:
        condensed = [_condense(c, i + 1, len(chunks)) for i, c in enumerate(chunks)]
        notes = "\n".join(n for n in condensed if n)

    system = (
        "You are a meeting-notes assistant. From the notes below, produce a JSON "
        "object with exactly two fields: "
        '"summary" (2-4 sentence plain-English overview of the conversation) and '
        '"key_points" (an array of 4-8 short strings: the most important '
        "decisions, takeaways, and action items). "
        "Reply with ONLY the JSON object, no extra text."
    )
    raw = _chat(system, f"Notes:\n\n{notes}", as_json=True)

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SummaryUnavailable(f"Model did not return valid JSON: {exc}") from exc

    summary = str(parsed.get("summary", "")).strip()
    key_points_raw = parsed.get("key_points", []) or []
    key_points = [str(k).strip() for k in key_points_raw if str(k).strip()]

    if not summary and not key_points:
        raise SummaryUnavailable("Model returned an empty summary.")

    return {"summary": summary, "key_points": key_points}
