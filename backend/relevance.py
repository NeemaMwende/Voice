"""Separate the business discussion from the small talk.

``cleaning.py`` removes *lexical* noise — "uhh", stutters, "[BLANK_AUDIO]". It
cannot touch a sentence like "Hey Neema, are you feeling cold? Switch off the
AC", which is perfectly well-formed English and completely irrelevant to the
procedure being described. Deciding that is a judgement call, so it needs the
model.

Two rules govern this module:

1. **Classify, never rewrite.** Every sentence keeps its exact wording; all we
   attach is a label. Nothing is deleted from storage, so the verbatim view
   stays a complete record of what was said and the UI can show precisely what
   was set aside and why. It also keeps the frontend's raw↔clean word diff
   valid, which only works because no stage invents words.
2. **When unsure, keep.** Wrongly dropping a real requirement is far more
   damaging to a downstream SOP than leaving a stray pleasantry in. Anything
   the model is unsure about — and everything it fails to label at all — stays
   in the business set.

Config (env / .env):
  * RELEVANCE            — "0" disables the pass (default on)
  * RELEVANCE_MODEL      — model to classify with (default: OLLAMA_MODEL)
  * RELEVANCE_BATCH      — sentences per request (default 30)
"""

from __future__ import annotations

import os
from typing import Any, Callable, Dict, List, Optional

import summarization

ENABLED = os.environ.get("RELEVANCE", "1") in ("1", "true", "True")

# Relevance judgement is a harder task than summarising, and a small model will
# happily call a requirement "small talk". Point this at the largest
# instruction-tuned model available (llama3.1 / mistral / qwen2.5:14b).
MODEL = os.environ.get("RELEVANCE_MODEL") or summarization.OLLAMA_MODEL

BATCH = int(os.environ.get("RELEVANCE_BATCH", "30"))

BUSINESS = "business"
SMALL_TALK = "smalltalk"

# Sentences shorter than this are almost always backchannel ("Yeah.", "Right.")
# but they're also cheap to keep, and dropping them can strip a real answer
# ("Yes." to a direct question). They go to the model like everything else.
ProgressFn = Optional[Callable[[float], None]]

_SYSTEM = (
    "You are separating the substantive business content of a meeting "
    "transcript from incidental chatter, so the business content can be turned "
    "into a Standard Operating Procedure.\n\n"
    "You will get numbered sentences. Label each one:\n"
    '  "business"  — anything that describes how work is done or decided: '
    "process steps, who does what, tools and systems, inputs and outputs, "
    "rules, conditions, exceptions, decisions, commitments, deadlines, "
    "numbers, requirements, problems with the process, questions about the "
    "process and their answers.\n"
    '  "smalltalk"  — incidental conversation that would look out of place in '
    "a procedure document: greetings and goodbyes, thanks and pleasantries, "
    "weather, room temperature, air conditioning, food and drink, health, "
    "family, holidays, sport, jokes and banter, audio-visual checks "
    "(\"can you hear me\", \"you're on mute\", \"my screen froze\", "
    '"let me share my screen"), and scheduling chatter about the meeting '
    "itself.\n\n"
    "Rules:\n"
    "- Judge each sentence in the context of the ones around it. Sentences "
    "come in spoken order and an aside usually runs for two or three in a "
    "row, so a sentence continuing the topic of a smalltalk sentence is "
    "almost always smalltalk too.\n"
    "- A sentence phrased as an instruction is NOT automatically business. Ask "
    "what it is an instruction *about*. Instructions concerning the meeting "
    "room or the call — the air conditioning, lights, a window or door, "
    "seating, volume, someone's microphone or screen — are smalltalk, because "
    "they are about the room the people are sitting in, not about the work "
    "being described. Only instructions about the actual work process are "
    "business.\n"
    "- If a sentence is even arguably about the work, label it business.\n"
    '- Only use "smalltalk" when you are confident it carries no procedural '
    "information whatsoever.\n"
    '- For every smalltalk sentence add a short "reason" (a few words).\n\n'
    'Reply with ONLY: {"labels": [{"id": 1, "label": "business"}, '
    '{"id": 2, "label": "smalltalk", "reason": "asks about the air '
    'conditioning"}]}\n'
    "Include every id you were given, exactly once."
)


def _classify_batch(items: List[Dict[str, Any]]) -> Dict[int, Dict[str, str]]:
    """Label one batch. Returns {id: {"label", "reason"}} — missing ids kept."""
    # Speaker labels help: an aside is usually one person cutting across the
    # thread, which is far easier to spot when you can see who said what.
    listing = "\n".join(f'{it["id"]}. {it["speaker"]}: {it["text"]}' for it in items)
    try:
        parsed = summarization._chat_json(
            _SYSTEM, f"Sentences:\n\n{listing}", model=MODEL
        )
    except summarization.SummaryUnavailable as exc:
        print(f"[relevance] model unavailable, keeping everything: {exc}")
        return {}

    out: Dict[int, Dict[str, str]] = {}
    raw_labels = parsed.get("labels")
    if not isinstance(raw_labels, list):
        return {}

    for entry in raw_labels:
        if not isinstance(entry, dict):
            continue
        try:
            sid = int(entry.get("id"))
        except (TypeError, ValueError):
            continue
        label = str(entry.get("label", "")).strip().lower()
        # Anything that isn't an explicit, well-formed "smalltalk" is kept.
        if label != SMALL_TALK:
            continue
        out[sid] = {
            "label": SMALL_TALK,
            "reason": str(entry.get("reason", "")).strip()[:120],
        }
    return out


def label_segments(
    segments: List[Dict[str, Any]], *, on_progress: ProgressFn = None
) -> List[Dict[str, Any]]:
    """Label every sentence, then build each turn's business-only text.

    Adds ``relevant`` to each segment (the cleaned business sentences joined)
    and sets ``label``/``reason`` on each entry in ``sentences``. Segments are
    mutated in place and returned.
    """
    # Only sentences with cleaned content are worth asking about: one that
    # cleaned down to nothing was pure filler and is already accounted for.
    index: List[Dict[str, Any]] = []
    for seg in segments:
        for sentence in seg.get("sentences", []):
            if sentence.get("clean", "").strip():
                index.append(
                    {
                        "id": len(index) + 1,
                        "speaker": seg.get("speaker", "Speaker"),
                        "text": sentence["clean"],
                        "ref": sentence,
                    }
                )

    if ENABLED and index:
        batches = [index[i : i + BATCH] for i in range(0, len(index), BATCH)]
        for n, batch in enumerate(batches):
            for sid, verdict in _classify_batch(batch).items():
                for item in batch:
                    if item["id"] == sid:
                        item["ref"]["label"] = verdict["label"]
                        if verdict["reason"]:
                            item["ref"]["reason"] = verdict["reason"]
                        break
            if on_progress:
                on_progress((n + 1) / len(batches))
    elif not ENABLED:
        print("[relevance] disabled; keeping every sentence")

    for seg in segments:
        seg["relevant"] = _join_business(seg.get("sentences", []))
    return segments


def _join_business(sentences: List[Dict[str, Any]]) -> str:
    """Cleaned text of the business sentences, in order."""
    kept = [
        s.get("clean", "").strip()
        for s in sentences
        if s.get("label", BUSINESS) != SMALL_TALK and s.get("clean", "").strip()
    ]
    return " ".join(kept).strip()


def counts(segments: List[Dict[str, Any]]) -> Dict[str, int]:
    """Small-talk vs business sentence tallies, for logging."""
    small = sum(
        1
        for seg in segments
        for s in seg.get("sentences", [])
        if s.get("label") == SMALL_TALK
    )
    total = sum(len(seg.get("sentences", [])) for seg in segments)
    return {"smalltalk": small, "total": total}
