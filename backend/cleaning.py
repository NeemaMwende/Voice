"""Turn a verbatim transcript turn into a clean, readable one.

Whisper is prompted to write down *everything* — "uhh", "hmm", stutters,
half-restarted sentences, bracketed noise tags. That verbatim text is what the
Transcript tab shows under "Verbatim"; this module produces the tidied version
shown beside it, and the frontend diffs the two to highlight exactly what came
out (see ``diffRaw`` in frontend/lib/notes.ts).

The rules are deliberately conservative and deterministic — no model call. A
word is only dropped when it is unambiguously noise, because a cleaner that
quietly deletes real content is far worse than one that leaves an "actually"
behind. In particular, hedges like "like" or "basically" are removed only when
comma-delimited (", like,"), which is where they act as filler rather than
carrying meaning.
"""

from __future__ import annotations

import re

# Non-speech annotations Whisper emits: [BLANK_AUDIO], (laughs), *coughs*.
_ANNOTATION_RE = re.compile(r"[\[(*]\s*[^\])*\n]{1,40}\s*[\])*]")

# Hesitation sounds. These are never meaningful words, so they always go.
# Longest alternatives first: Python's alternation is first-match-wins, so a
# leading `u+h+` would eat the "uh" of "uh-huh" and strand the "-huh".
_INTERJECTION = (
    r"(?:u+h[-\s]?hu+h|m+h+m+|u+h+m+|hu+h|u+h+|u+m+|e+r+m*|a+h+|h+m+|e+h)"
)
_INTERJECTION_RE = re.compile(rf"\b{_INTERJECTION}\b[,;.!?]*", re.IGNORECASE)
# "…database, uh, is Postgres" — the commas only existed to fence the filler,
# so they go with it rather than leaving "…database, is Postgres".
_INTERJECTION_MID_RE = re.compile(rf",\s*{_INTERJECTION}\s*,", re.IGNORECASE)

# Hedges/discourse markers — only filler when set off by commas. Deliberately
# excludes "okay", "so" and "right": they read as filler but routinely carry
# meaning ("That's much, okay?" is a question, not a verbal tic), and this pass
# has no way to tell the two apart.
_HEDGE = (
    r"(?:you know|i mean|sort of|kind of|you see|i guess|like|basically|"
    r"actually|literally|obviously|honestly)"
)
_HEDGE_MID_RE = re.compile(rf",\s*{_HEDGE}\s*,", re.IGNORECASE)
_HEDGE_LEAD_RE = re.compile(rf"^\s*{_HEDGE}\s*,\s*", re.IGNORECASE)
_HEDGE_TRAIL_RE = re.compile(rf",\s*{_HEDGE}\s*([.!?])?\s*$", re.IGNORECASE)

# Hyphenated stutters — "th-th-the", "I-I-I". Requires the fragment to actually
# repeat, so real hyphenated words ("co-operate", "x-ray") are left alone.
_STUTTER_HYPHEN_RE = re.compile(r"\b(\w{1,4})(?:-\1)+(-\w+)?\b", re.IGNORECASE)

# Immediately repeated words — "the the the", "we we".
_STUTTER_WORD_RE = re.compile(r"\b(\w+)(?:[ ,]+\1\b)+", re.IGNORECASE)

# Tidy-up passes, applied in order.
_SPACE_BEFORE_PUNCT_RE = re.compile(r"\s+([,;:.!?])")
_REPEATED_COMMA_RE = re.compile(r"(,\s*){2,}")
_DANGLING_LEAD_RE = re.compile(r"^[\s,;:]+")
_MULTI_SPACE_RE = re.compile(r"[ \t]{2,}")
# Removing a filler can strand a sentence starting lowercase ("Uh, I mean,
# don't…" → "don't…"), so recapitalise after every sentence break, not just
# at the start of the turn.
_SENTENCE_START_RE = re.compile(r"(^|[.!?]\s+)([a-z])")


def _drop_stutter_hyphen(match: re.Match) -> str:
    """"th-th-the" → "the"; "I-I-I" → "I"."""
    tail = match.group(2)
    return tail.lstrip("-") if tail else match.group(1)


def _clean_line(line: str) -> str:
    text = _ANNOTATION_RE.sub(" ", line)
    text = _STUTTER_HYPHEN_RE.sub(_drop_stutter_hyphen, text)

    # Comma-fenced fillers first, taking their commas with them; then any
    # remaining bare ones. Both passes repeat so back-to-back fillers
    # (", you know, like,") collapse instead of leaving every other one.
    for pattern in (_INTERJECTION_MID_RE, _HEDGE_MID_RE):
        for _ in range(4):
            replaced = pattern.sub(" ", text)
            if replaced == text:
                break
            text = replaced

    text = _INTERJECTION_RE.sub(" ", text)
    text = _HEDGE_LEAD_RE.sub("", text)
    text = _HEDGE_TRAIL_RE.sub(r"\1", text)

    text = _STUTTER_WORD_RE.sub(r"\1", text)

    text = _MULTI_SPACE_RE.sub(" ", text)
    text = _SPACE_BEFORE_PUNCT_RE.sub(r"\1", text)
    text = _REPEATED_COMMA_RE.sub(", ", text)
    text = _DANGLING_LEAD_RE.sub("", text)
    text = text.strip()

    # A turn that was nothing but filler ("Umm, uh...") cleans down to
    # punctuation; treat that as empty rather than showing a stray comma.
    if not re.search(r"[A-Za-z0-9]", text):
        return ""

    return _SENTENCE_START_RE.sub(lambda m: m.group(1) + m.group(2).upper(), text)


def clean_text(text: str) -> str:
    """Strip fillers, stutters and noise tags, preserving paragraph breaks."""
    if not text or not text.strip():
        return ""
    # consolidate_segments joins long turns with blank lines — keep that shape
    # so the cleaned pane lines up with the verbatim one.
    cleaned = [_clean_line(line) for line in text.split("\n")]
    out = "\n".join(cleaned)
    # An empty result is a real answer, not a failure: a turn that was nothing
    # but "Umm, uh…" has no clean version, and the UI says so explicitly.
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def count_removed(raw: str, cleaned: str) -> int:
    """How many words the cleaning pass dropped (for the UI's noise counter)."""
    return max(0, len(raw.split()) - len(cleaned.split()))
