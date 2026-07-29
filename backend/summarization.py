"""Transcript summarization via a local Ollama server.

Turns the raw transcript into the structured note set the UI renders:

  * overview      — a few sentences describing the conversation
  * key_points    — the most important takeaways
  * insights      — themed groups (decisions, risks, numbers, …)
  * action_items  — commitments / follow-ups
  * outline       — chronological topic-by-topic breakdown of the whole talk

Long meetings are handled map-reduce style: each chunk is condensed to notes
*and* its own outline sections (so nothing is lost from the middle of a long
conversation), then a final pass produces the overview / key points / insights
/ action items from the condensed notes.

This module also recovers real speaker names from a diarized transcript —
people usually introduce themselves, and "Collins Kipkorir" reads far better
than "Speaker 2".

Config (env / .env):
  * OLLAMA_URL   — base URL of the Ollama server (default http://localhost:11434)
  * OLLAMA_MODEL — model to use (default llama3.1:8b)
"""

from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Callable, Dict, List, Optional

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")

# Characters per map-reduce chunk. ~6k chars ≈ 1.5k tokens, comfortably inside
# the context window we request below with room for the prompt + output.
CHUNK_CHARS = 6000
NUM_CTX = 8192
REQUEST_TIMEOUT = 300  # seconds; local models can be slow on long inputs

# How much of the (speaker-labelled) transcript to show the name-detection pass.
# Introductions almost always happen in the opening minutes.
NAME_SCAN_CHARS = 7000

ProgressFn = Optional[Callable[[float, str], None]]


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


def _chat_json(system: str, user: str) -> Dict[str, object]:
    """Chat in JSON mode, returning ``{}`` rather than raising on bad output.

    Individual passes are best-effort: losing the insights section shouldn't
    cost the caller its overview.
    """
    raw = _chat(system, user, as_json=True)
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


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


def _strings(value: object, *, limit: int = 40) -> List[str]:
    """Coerce a model-produced list into clean, de-duplicated strings."""
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    out: List[str] = []
    seen = set()
    for item in value:
        if isinstance(item, dict):
            item = item.get("text") or item.get("item") or item.get("point") or ""
        text = re.sub(r"^\s*[-*•]\s*", "", str(item)).strip()
        if not text:
            continue
        marker = text.lower()
        if marker in seen:
            continue
        seen.add(marker)
        out.append(text)
        if len(out) >= limit:
            break
    return out


def _sections(value: object, *, limit: int = 24) -> List[Dict[str, object]]:
    """Coerce a model-produced list into ``[{heading, bullets}]`` sections."""
    if not isinstance(value, list):
        return []
    out: List[Dict[str, object]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        heading = str(
            item.get("heading") or item.get("title") or item.get("topic") or ""
        ).strip()
        bullets = _strings(
            item.get("bullets") or item.get("points") or item.get("items") or []
        )
        if not heading or not bullets:
            continue
        out.append({"heading": heading, "bullets": bullets})
        if len(out) >= limit:
            break
    return out


def _merge_sections(sections: List[Dict[str, object]]) -> List[Dict[str, object]]:
    """Fold consecutive sections that share a heading (chunk-boundary overlap)."""
    merged: List[Dict[str, object]] = []
    for section in sections:
        prev = merged[-1] if merged else None
        if prev and str(prev["heading"]).lower() == str(section["heading"]).lower():
            bullets = list(prev["bullets"]) + list(section["bullets"])  # type: ignore[arg-type]
            prev["bullets"] = _strings(bullets)
            continue
        merged.append(dict(section))
    return merged


def _is_meaningful(text: str) -> bool:
    return bool(text and len(text.split()) >= 3)


# ---------------------------------------------------------------------------
# Map step — condense a chunk to notes plus its own outline sections
# ---------------------------------------------------------------------------

_MAP_SYSTEM = (
    "You are a meeting-notes assistant reading one part of a conversation "
    "transcript. Reply with ONLY a JSON object with exactly two fields:\n"
    '  "notes": an array of terse bullet strings capturing every topic '
    "discussed, decision made, question raised, number or name mentioned, and "
    "any commitment or follow-up.\n"
    '  "sections": an array of 1-4 objects, each {"heading": short topic title, '
    '"bullets": array of 2-6 sentences describing what was said under that '
    "topic, in the order it was said}. Attribute statements to the speaker by "
    "name when the transcript names them (e.g. \"Collins Kipkorir explains …\").\n"
    "Cover the whole excerpt. Do not invent anything that is not in the text."
)


def _map_chunk(chunk: str, index: int, total: int) -> Dict[str, object]:
    label = f"Transcript part {index} of {total}" if total > 1 else "Transcript"
    parsed = _chat_json(_MAP_SYSTEM, f"{label}:\n\n{chunk}")
    return {
        "notes": _strings(parsed.get("notes", []), limit=60),
        "sections": _sections(parsed.get("sections", []), limit=6),
    }


# ---------------------------------------------------------------------------
# Reduce step — overview / key points, then insights / action items
# ---------------------------------------------------------------------------

_OVERVIEW_SYSTEM = (
    "You are a meeting-notes assistant. From the notes below, reply with ONLY a "
    "JSON object with exactly two fields: "
    '"summary" (a 3-5 sentence plain-English overview of what the conversation '
    "was about, who took part, and where it landed) and "
    '"key_points" (an array of 5-10 short strings: the most important '
    "takeaways, decisions and facts). Do not invent anything."
)

_INSIGHTS_SYSTEM = (
    "You are a meeting-notes assistant. From the notes below, reply with ONLY a "
    "JSON object with exactly two fields:\n"
    '  "action_items": an array of 0-10 strings. Each one is a task somebody '
    "agreed to DO after the meeting. Start each with a verb, say who owns it, "
    "and include enough detail to act on it. A topic that was merely discussed "
    "is NOT an action item — if nobody committed to anything, return an empty "
    "array.\n"
    '  "insights": an array of 2-5 objects {"heading": a short theme, '
    '"bullets": array of 2-5 short factual sentences}. Group related facts '
    "under each theme; never emit a theme with only one bullet. Choose only "
    "themes the conversation actually covers — for example Decisions, "
    "Risks & blockers, Open questions, Numbers & pricing, Tools & systems, "
    "Timeline. Do not invent anything.\n"
    "Example of the shape and level of detail expected:\n"
    '{"action_items": ["Provision a free sandbox account for the client team '
    'so they can test the product (Andrew)", "Confirm which vector database '
    'the agent system uses and send the technical details (Andrew)"], '
    '"insights": [{"heading": "Pricing", "bullets": ["The product is '
    'token-based; LLM usage is charged.", "$25/month grants 400 tokens."]}]}'
)


def summarize(transcript: str, *, on_progress: ProgressFn = None) -> Dict[str, object]:
    """Build the full note set for a transcript.

    Returns ``{"summary", "key_points", "action_items", "insights", "outline"}``.
    Raises SummaryUnavailable if the model can't produce anything usable.

    ``on_progress(fraction, label)`` is called with 0.0-1.0 as passes complete,
    so the caller can surface real progress while a slow local model works.
    """
    transcript = (transcript or "").strip()
    if not _is_meaningful(transcript):
        raise SummaryUnavailable("Transcript too short to summarize.")

    def report(fraction: float, label: str) -> None:
        if on_progress:
            on_progress(fraction, label)

    chunks = _chunk(transcript, CHUNK_CHARS)
    notes_lines: List[str] = []
    outline: List[Dict[str, object]] = []
    for i, chunk in enumerate(chunks):
        mapped = _map_chunk(chunk, i + 1, len(chunks))
        notes_lines.extend(str(n) for n in mapped["notes"])  # type: ignore[union-attr]
        outline.extend(mapped["sections"])  # type: ignore[arg-type]
        # The map step is the bulk of the work; give it 70% of the progress bar.
        report(0.7 * (i + 1) / len(chunks), f"Reading part {i + 1} of {len(chunks)}")

    outline = _merge_sections(outline)
    notes = "\n".join(f"- {line}" for line in notes_lines) or transcript

    overview_parsed = _chat_json(_OVERVIEW_SYSTEM, f"Notes:\n\n{notes}")
    summary = str(overview_parsed.get("summary", "")).strip()
    key_points = _strings(overview_parsed.get("key_points", []), limit=12)
    report(0.85, "Writing the overview")

    insights_parsed = _chat_json(_INSIGHTS_SYSTEM, f"Notes:\n\n{notes}")
    action_items = _strings(insights_parsed.get("action_items", []), limit=12)
    insights = _sections(insights_parsed.get("insights", []), limit=6)
    report(1.0, "Pulling out insights")

    if not (summary or key_points or outline or insights or action_items):
        raise SummaryUnavailable("Model returned an empty summary.")

    return {
        "summary": summary,
        "key_points": key_points,
        "action_items": action_items,
        "insights": insights,
        "outline": outline,
    }


# ---------------------------------------------------------------------------
# Speaker naming
# ---------------------------------------------------------------------------

_NAMES_SYSTEM = (
    "You are reading a diarized meeting transcript where each turn is labelled "
    "'Speaker 1', 'Speaker 2', and so on. Work out the real name of each "
    "speaker from what is actually said — people introduce themselves (\"I'm "
    "Sarah\", \"my name is …\", \"this is …\") or are addressed and thanked by "
    "name by others.\n"
    "Reply with ONLY a JSON object mapping each speaker label to their name, "
    'e.g. {"Speaker 1": "Sarah Otieno", "Speaker 2": null}. '
    "Use null for any speaker whose name is never stated. Never guess, never "
    "invent a name, and never reuse the same name for two speakers."
)

# A plausible human name: 1-3 capitalised words, no digits or punctuation soup.
_NAME_RE = re.compile(r"^[A-Z][\w'’.-]*(?: [A-Z][\w'’.-]*){0,2}$")


def _plausible_name(value: object, transcript: str) -> Optional[str]:
    if not isinstance(value, str):
        return None
    name = value.strip().strip(".,")
    if not name or len(name) > 40:
        return None
    if re.match(r"(?i)^speaker\b", name) or name.lower() in {"unknown", "none", "null", "n/a"}:
        return None
    if not _NAME_RE.match(name):
        return None
    # Only trust a name the transcript actually contains — blocks hallucination.
    first = name.split()[0]
    return name if re.search(rf"\b{re.escape(first)}\b", transcript, re.IGNORECASE) else None


def identify_speakers(labeled_transcript: str, labels: List[str]) -> Dict[str, str]:
    """Map ``Speaker N`` labels to real names mentioned in the conversation.

    Returns only the labels a name was confidently found for; anything missing
    keeps its ``Speaker N`` fallback. Never raises — naming is a nicety.
    """
    if not labels or not _is_meaningful(labeled_transcript):
        return {}

    excerpt = labeled_transcript[:NAME_SCAN_CHARS]
    user = (
        f"Speaker labels used: {', '.join(labels)}\n\n"
        f"Transcript:\n\n{excerpt}"
    )
    try:
        parsed = _chat_json(_NAMES_SYSTEM, user)
    except SummaryUnavailable:
        return {}

    resolved: Dict[str, str] = {}
    taken = set()
    for label in labels:
        name = _plausible_name(parsed.get(label), labeled_transcript)
        if not name or name.lower() in taken:
            continue
        taken.add(name.lower())
        resolved[label] = name
    return resolved
