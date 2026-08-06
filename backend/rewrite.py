"""Tidy the business-only transcript into something a summarizer can work from.

By the time this runs, two passes have already been made over the transcript:
``cleaning.py`` took out the fillers and ``relevance.py`` set the small talk
aside. What is left is *correct* but still reads like speech — restarted
sentences, missing verbs, clauses that got stranded when the filler between
them was removed, punctuation Whisper guessed at, and turns that now jump
because a sentence in the middle of them was dropped.

That unevenness is exactly what makes a local summarizer produce mush. So this
stage rewrites each turn's business text into plain, grammatical sentences —
and *only* that:

  * no new facts, names, numbers or conclusions;
  * no summarising, shortening or merging of turns;
  * speaker, start and end are untouched, so the output is still a transcript
    and every downstream consumer keeps working.

The rewrite lands in a new ``polished`` field. ``relevant`` — the true cleaned
business text — is left exactly as it was, because that is what the transcript
UI renders and what the raw↔clean diff depends on. Only the notes and the
business record read ``polished``.

**Every rewrite is checked before it is accepted.** A local model asked to tidy
prose will sometimes summarise instead, or invent a name. ``_faithful`` rejects
a rewrite that drops too much of the original's content words, changes its
length materially, or introduces a number or a capitalised name that was not in
the source. A rejected rewrite is not a failure — the turn simply keeps its
unrewritten text, and the count is logged.

Config (env / .env):
  * REWRITE        — "0" disables the pass (default on)
  * REWRITE_MODEL  — model to rewrite with (default: OLLAMA_MODEL)
  * REWRITE_CHARS  — characters of transcript per request (default 2500)
"""

from __future__ import annotations

import os
import re
from typing import Any, Callable, Dict, List, Optional

import summarization

ENABLED = os.environ.get("REWRITE", "1") in ("1", "true", "True")
MODEL = os.environ.get("REWRITE_MODEL") or summarization.OLLAMA_MODEL

# Batched by characters rather than by turn count: turns vary from three words
# to three paragraphs, and it is the context window that actually binds.
CHARS_PER_REQUEST = int(os.environ.get("REWRITE_CHARS", "2500"))

# A turn shorter than this has nothing to gain from a rewrite ("Yes.", "Agreed.")
# and everything to lose, since the model tends to embellish a fragment.
MIN_CHARS = 25

ProgressFn = Optional[Callable[[float], None]]

_SYSTEM = (
    "You repair the wording of a meeting transcript. The transcript has already "
    "had its filler words and its off-topic sentences removed, which sometimes "
    "leaves a turn reading awkwardly or breaking mid-thought.\n\n"
    "For each numbered turn, rewrite the words into clear, grammatical "
    "sentences. That means:\n"
    "- finish sentences that were left hanging, using only what the turn "
    "already says;\n"
    "- repair grammar, word order, verb tense and punctuation;\n"
    "- remove a restarted or repeated phrase, keeping the completed version;\n"
    "- keep the speaker's own vocabulary, and keep it in the first person if it "
    "was said in the first person.\n\n"
    "You must NOT:\n"
    "- add any fact, name, number, date, reason or conclusion that is not "
    "already in that turn;\n"
    "- summarise, shorten or leave anything out — every point in the turn must "
    "still be there afterwards;\n"
    "- merge turns, reorder them, or move content between them;\n"
    "- change any figure, amount, date, deadline, system name or identifier;\n"
    "- add commentary, headings, bullet points or speaker labels.\n\n"
    "If a turn already reads correctly, return it unchanged. If a turn is too "
    "fragmentary to repair honestly, return it unchanged rather than guessing.\n\n"
    'Reply with ONLY: {"turns": [{"id": 1, "text": "…"}, {"id": 2, "text": "…"}]}\n'
    "Include every id you were given, exactly once."
)

# ── Faithfulness checks ──────────────────────────────────────────────────────
_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'’\-]*")
_NUMBER_RE = re.compile(r"\d[\d,.:/]*")
_PROPER_RE = re.compile(r"\b[A-Z][a-z'’\-]{2,}\b")
# Words that carry the content: long enough to matter, and not the handful of
# short function words a rewrite is free to drop or add.
_MIN_CONTENT_LEN = 5

# A rewrite may tighten or expand a little; well outside this band it is
# summarising or padding, not repairing.
_MIN_RATIO = 0.55
_MAX_RATIO = 1.70
# How much of the original's content vocabulary must survive.
_MIN_RETENTION = 0.65


def _words(text: str) -> List[str]:
    return _WORD_RE.findall(text)


def _content(text: str) -> set:
    return {w.lower() for w in _words(text) if len(w) >= _MIN_CONTENT_LEN}


def _sentence_initial(text: str) -> set:
    """Words that start a sentence — capitalised for grammar, not as names."""
    return {
        m.group(1).lower()
        for m in re.finditer(r"(?:^|[.!?]\s+)([A-Za-z][A-Za-z'’\-]*)", text)
    }


# Grammar glue a repair is allowed to introduce at the start of a sentence it
# has just finished off. Deliberately tiny and function-word only: capitalising
# a *name* that wasn't in the turn is the failure this check exists to catch,
# and "…gateway. Sarah needs to resolve it" is exactly how it shows up.
_REPAIR_WORDS = frozenset(
    """the this that these those there then they and but also however because
    which what when while after before with without for from into our their his
    her its was were are have has had will would should could need needs let
    please once since though than each any all both either neither""".split()
)
# Shared-prefix length that counts a word as a form of one already in the turn
# ("resolve" → "resolving", "deploy" → "deployment").
_STEM_LEN = 5


def _known(word: str, vocab: set, stems: set, initial: set) -> bool:
    lower = word.lower()
    if lower in vocab:
        return True
    if lower[:_STEM_LEN] in stems:
        return True
    return lower in initial and lower in _REPAIR_WORDS


def _faithful(source: str, candidate: str) -> bool:
    """Is `candidate` a repair of `source` rather than a summary or a fiction?"""
    if not candidate.strip():
        return False

    src_words, out_words = _words(source), _words(candidate)
    if not src_words or not out_words:
        return False

    ratio = len(out_words) / len(src_words)
    if not _MIN_RATIO <= ratio <= _MAX_RATIO:
        return False

    # Nothing numeric may appear that wasn't already there. (Numbers going
    # missing is caught by the retention check below.)
    if not set(_NUMBER_RE.findall(candidate)) <= set(_NUMBER_RE.findall(source)):
        return False

    # No invented proper nouns. A capitalised word is fine if the turn already
    # contained it (in any case), if it is another form of a word the turn
    # contained, or if it is grammar glue starting a repaired sentence.
    src_vocab = {w.lower() for w in src_words}
    stems = {w[:_STEM_LEN] for w in src_vocab if len(w) >= _STEM_LEN}
    initial = _sentence_initial(candidate)
    if any(
        not _known(word, src_vocab, stems, initial)
        for word in _PROPER_RE.findall(candidate)
    ):
        return False

    # And the content has to still be present. This is the check that catches a
    # model quietly summarising a six-line turn into one tidy sentence.
    src_content = _content(source)
    if src_content:
        kept = len(src_content & _content(candidate)) / len(src_content)
        if kept < _MIN_RETENTION:
            return False

    return True


# ── The pass ─────────────────────────────────────────────────────────────────
def _batches(items: List[Dict[str, Any]]) -> List[List[Dict[str, Any]]]:
    batches: List[List[Dict[str, Any]]] = []
    current: List[Dict[str, Any]] = []
    size = 0
    for item in items:
        if current and size + len(item["text"]) > CHARS_PER_REQUEST:
            batches.append(current)
            current, size = [], 0
        current.append(item)
        size += len(item["text"])
    if current:
        batches.append(current)
    return batches


def _rewrite_batch(items: List[Dict[str, Any]]) -> Dict[int, str]:
    """Rewrite one batch. Returns {id: text} for the rewrites that passed."""
    listing = "\n".join(f'{it["id"]}. {it["text"]}' for it in items)
    try:
        parsed = summarization._chat_json(
            _SYSTEM, f"Turns:\n\n{listing}", model=MODEL
        )
    except summarization.SummaryUnavailable as exc:
        print(f"[rewrite] model unavailable, keeping the text as-is: {exc}")
        return {}

    by_id = {it["id"]: it["text"] for it in items}
    out: Dict[int, str] = {}
    turns = parsed.get("turns")
    if not isinstance(turns, list):
        return {}

    for entry in turns:
        if not isinstance(entry, dict):
            continue
        try:
            tid = int(entry.get("id"))
        except (TypeError, ValueError):
            continue
        source = by_id.get(tid)
        if source is None:
            continue
        candidate = re.sub(r"\s+", " ", str(entry.get("text", ""))).strip()
        if _faithful(source, candidate):
            out[tid] = candidate
    return out


def polish_segments(
    segments: List[Dict[str, Any]], *, on_progress: ProgressFn = None
) -> List[Dict[str, Any]]:
    """Add ``polished`` to every segment: its business text, tidied up.

    Always sets the field — falling back to the unrewritten business text — so
    downstream code can read ``polished`` unconditionally. Segments are mutated
    in place and returned.
    """
    for seg in segments:
        seg["polished"] = seg.get("relevant", seg.get("clean", seg.get("text", "")))

    if not ENABLED:
        print("[rewrite] disabled; using the cleaned business text as-is")
        return segments

    # Only turns with enough business text to be worth repairing.
    index: List[Dict[str, Any]] = []
    for seg in segments:
        text = (seg.get("polished") or "").strip()
        if len(text) >= MIN_CHARS:
            index.append({"id": len(index) + 1, "text": text, "ref": seg})
    if not index:
        return segments

    batches = _batches(index)
    rewritten = 0
    for n, batch in enumerate(batches):
        accepted = _rewrite_batch(batch)
        for item in batch:
            text = accepted.get(item["id"])
            if text:
                item["ref"]["polished"] = text
                rewritten += 1
        if on_progress:
            on_progress((n + 1) / len(batches))

    print(
        f"[rewrite] {rewritten} of {len(index)} turns rewritten "
        f"({len(index) - rewritten} kept as-is)"
    )
    return segments


def counts(segments: List[Dict[str, Any]]) -> Dict[str, int]:
    """How many turns the rewrite actually changed, for logging."""
    changed = sum(
        1
        for seg in segments
        if (seg.get("polished") or "").strip() != (seg.get("relevant") or "").strip()
    )
    return {"rewritten": changed, "turns": len(segments)}
