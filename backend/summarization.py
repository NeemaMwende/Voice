"""Transcript summarization via a local Ollama server.

Turns the raw transcript into the structured note set the UI renders:

  * overview      — a few sentences describing the conversation
  * key_points    — the most important takeaways
  * insights      — themed groups (decisions, risks, numbers, …)
  * action_items  — commitments / follow-ups
  * outline       — chronological topic-by-topic breakdown of the whole talk

It also writes the **business record** (``summarize_business``): a detailed prose
account of the work discussed, extracted from the business-only tier of the
transcript. That is the text an SOP gets generated from, so it errs towards
keeping procedural detail rather than being short.

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


CHUNK_CHARS = 6000
NUM_CTX = 8192
REQUEST_TIMEOUT = 300  # seconds; local models can be slow on long inputs

# How much of the (speaker-labelled) transcript to show the name-detection pass.
# Introductions almost always happen in the opening minutes.
NAME_SCAN_CHARS = 7000

ProgressFn = Optional[Callable[[float, str], None]]

# The business record runs as a single stage, so its callback only reports how
# far through it is — the caller already knows what to label it.
FractionFn = Optional[Callable[[float], None]]


class SummaryUnavailable(RuntimeError):
    """Raised when the Ollama server can't be reached or returns nothing usable."""


def _chat(system: str, user: str, *, as_json: bool = False, model: Optional[str] = None) -> str:
    payload: Dict[str, object] = {
        "model": model or OLLAMA_MODEL,
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


def _chat_json(system: str, user: str, *, model: Optional[str] = None) -> Dict[str, object]:
    """Chat in JSON mode, returning ``{}`` rather than raising on bad output.

    Individual passes are best-effort: losing the insights section shouldn't
    cost the caller its overview.
    """
    raw = _chat(system, user, as_json=True, model=model)
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
# Invented-name guard
# ---------------------------------------------------------------------------
# Small local models happily attach an owner to every action item even when the
# transcript names nobody, reaching for placeholders ("John", "Jane") or a name
# lifted from the prompt's own example. The prompts below ask for no owner in
# that case, but asking isn't enough — so every generated string is also run
# through here, and any attribution naming a person the transcript never
# mentions is removed. Same principle as _plausible_name for speaker labels:
# trust a name only if the source text actually contains it.

_WORD_RE = re.compile(r"[A-Za-z][A-Za-z'’\-]*")

# One capitalised, non-acronym word — "Andrew" matches, "CRM" and "Q3" don't.
_PERSON_TOKEN_RE = re.compile(r"[A-Z][a-z'’\-]+")

# Up to three such words: "Jane", "Collins Kipkorir".
_NAME_PHRASE = r"[A-Z][a-z'’\-]+(?:\s+[A-Z][a-z'’\-]+){0,2}"

# Several of those conjoined: "John and Jane", "Sarah, Collins & Bob". Matched as
# one unit so removing an invented owner can't leave "and Jane" dangling.
_NAME_LIST = rf"{_NAME_PHRASE}(?:\s*(?:,|/|&|and)\s*{_NAME_PHRASE})*"
_NAME_SPLIT_RE = re.compile(r",|/|&|\band\b")

# Capitalised words that are never a person, so a date or deadline isn't mistaken
# for an owner and stripped out of an otherwise good action item.
_NOT_PERSON_WORDS = frozenset(
    {
        "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
        "sunday", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri",
        "sat", "sun",
        "january", "february", "march", "april", "may", "june", "july",
        "august", "september", "october", "november", "december",
        "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
        "nov", "dec",
        "today", "tomorrow", "yesterday", "tonight", "week", "month", "quarter",
        "year", "eod", "eow",
    }
)

# A trailing "(Owner)" / "[Owner, Owner]" credit.
_OWNER_PAREN_RE = re.compile(r"\s*[\(\[]\s*([^()\[\]]{1,60}?)\s*[\)\]]")

# "… to Jane", "… by Jane" — an owner named via a preposition.
_ATTRIB_PREP_RE = re.compile(
    rf"([,;]?\s+\b(?:by|to|for|with|from)\s+)({_NAME_LIST})\b"
)

# "Jane will confirm …", "Jane agreed to send …" — an owner in subject position.
# The modal goes with the name, leaving a bare imperative behind. A bare "to" is
# deliberately not in this list: it would read the leading verb of "Escalate to
# Sarah" as the name. _ATTRIB_PREP_RE already covers "to <Name>".
_ATTRIB_SUBJECT_RE = re.compile(
    rf"\b({_NAME_LIST})\s+(will|shall|should|must|needs\s+to|has\s+to|"
    rf"is\s+to|agreed\s+to|agrees\s+to)\s+"
)

# "Andrew raised the integration", "John and Jane discussed the CRM" — narrative
# attribution in the overview and key points. Only verbs that demand a human
# subject are listed, so an invented *non*-name ("Compliance is required") can't
# be mistaken for a person; generic is/has/needs are deliberately excluded.
_REPORTING_VERBS = (
    r"said|says|asked|asks|added|adds|noted|notes|mentioned|mentions|"
    r"explained|explains|described|describes|confirmed|confirms|raised|raises|"
    r"discussed|discusses|suggested|suggests|proposed|proposes|requested|"
    r"requests|reported|reports|agreed|agrees|clarified|clarifies|"
    r"emphasized|emphasizes|emphasised|emphasises|highlighted|highlights|outlined|"
    r"outlines|presented|presents|introduced|introduces|promised|promises|"
    r"committed|commits|volunteered|offered|offers|thanked|thanks|joined|"
    r"joins|owns|leads|manages|handles"
)
_ATTRIB_NARRATIVE_RE = re.compile(rf"\b({_NAME_LIST})\s+(?={_REPORTING_VERBS}\b)")


def _vocabulary(text: str) -> set:
    """Every word in the source text, lowercased — the set of names we trust."""
    return {match.group(0).lower() for match in _WORD_RE.finditer(text)}


def _has_unknown_name(phrase: str, vocab: set) -> bool:
    """True if ``phrase`` names a person the source text never mentions."""
    tokens = _PERSON_TOKEN_RE.findall(phrase)
    if not tokens:
        return False
    return any(
        token.lower() not in _NOT_PERSON_WORDS and token.lower() not in vocab
        for token in tokens
    )


def _split_names(phrase: str) -> List[str]:
    return [part.strip() for part in _NAME_SPLIT_RE.split(phrase) if part.strip()]


def _keep_known(phrase: str, vocab: set) -> Optional[str]:
    """The verified part of ``phrase``, or None if all of it is invented.

    Filters token by token, not name by name: when the model bolts an invented
    surname onto a real first name, "Collins Kipkorir" should come back as
    "Collins" rather than being thrown away wholesale.
    """
    kept: List[str] = []
    for part in _split_names(phrase):
        tokens = [
            token
            for token in _PERSON_TOKEN_RE.findall(part)
            if token.lower() in vocab or token.lower() in _NOT_PERSON_WORDS
        ]
        if tokens:
            kept.append(" ".join(tokens))
    return " and ".join(kept) if kept else None


# Endings a person's name effectively never has, but a topic word often does. A
# capitalised topic word slipping past the vocabulary check ("Pricing discussed
# at length") must not be rewritten as if it were a participant.
_TOPIC_WORD_SUFFIXES = (
    "ing", "tion", "sion", "ment", "ness", "ance", "ence", "ity", "ism",
    "logy", "ship", "hood", "ware", "ability",
)


def _looks_like_topic_word(phrase: str) -> bool:
    tokens = _PERSON_TOKEN_RE.findall(phrase)
    return bool(tokens) and all(
        token.lower().endswith(_TOPIC_WORD_SUFFIXES) for token in tokens
    )


def _is_owner_list(inner: str) -> bool:
    """True if a parenthetical holds nothing but names — "(Jane)", "(Jane, Bob)".

    Keeps real asides like "(see the Q3 numbers)" out of the scrubber's reach.
    """
    parts = _split_names(inner)
    return bool(parts) and all(re.fullmatch(_NAME_PHRASE, part) for part in parts)


def _tidy(text: str) -> str:
    """Close up the whitespace and dangling punctuation a removal leaves behind."""
    text = re.sub(r"[\(\[]\s*[\)\]]", "", text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"([,;])\1+", r"\1", text)
    text = text.strip().strip(",;").strip()
    if text and text[0].islower():
        text = text[0].upper() + text[1:]
    return text


def _drop_paren(match: "re.Match[str]", vocab: set) -> str:
    """"Confirm the CRM tasks (Jane)" -> "Confirm the CRM tasks"."""
    inner = match.group(1)
    if not (_is_owner_list(inner) and _has_unknown_name(inner, vocab)):
        return match.group(0)
    survivors = _keep_known(inner, vocab)
    return f" ({survivors})" if survivors else ""


def _drop_prep(match: "re.Match[str]", vocab: set) -> str:
    """"Assign the project to John" -> "Assign the project"."""
    preposition, names = match.group(1), match.group(2)
    if not _has_unknown_name(names, vocab):
        return match.group(0)
    survivors = _keep_known(names, vocab)
    return f"{preposition}{survivors}" if survivors else ""


def _drop_subject(match: "re.Match[str]", vocab: set) -> str:
    """"Jane will confirm the tasks" -> "Confirm the tasks".

    The modal goes with the invented name so an imperative is left behind,
    which is the voice the rest of the action items are written in.
    """
    names, verb = match.group(1), match.group(2)
    if not _has_unknown_name(names, vocab):
        return match.group(0)
    survivors = _keep_known(names, vocab)
    return f"{survivors} {verb} " if survivors else ""


def _anonymize_subject(match: "re.Match[str]", vocab: set) -> str:
    """"Andrew raised the integration" -> "One participant raised the integration".

    Deleting a sentence's subject would wreck it, so the speaker is described
    generically instead — accurate, and invents nobody.
    """
    names = match.group(1)
    if not _has_unknown_name(names, vocab) or _looks_like_topic_word(names):
        return match.group(0)
    survivors = _keep_known(names, vocab)
    if survivors:
        return f"{survivors} "
    return "participants " if len(_split_names(names)) > 1 else "one participant "


_NAME_RULES = (
    (_OWNER_PAREN_RE, _drop_paren),
    (_ATTRIB_PREP_RE, _drop_prep),
    (_ATTRIB_SUBJECT_RE, _drop_subject),
    (_ATTRIB_NARRATIVE_RE, _anonymize_subject),
)


def _scrub_names(text: str, vocab: set) -> str:
    """Strip owner attributions that name someone absent from the transcript."""
    if not text:
        return ""
    for pattern, rule in _NAME_RULES:
        text = pattern.sub(lambda match, _rule=rule: _rule(match, vocab), text)
    return _tidy(text)


def _scrub_all(values: List[str], vocab: set) -> List[str]:
    return [cleaned for cleaned in (_scrub_names(v, vocab) for v in values) if cleaned]


def _scrub_sections(
    sections: List[Dict[str, object]], vocab: set
) -> List[Dict[str, object]]:
    out: List[Dict[str, object]] = []
    for section in sections:
        heading = _scrub_names(str(section.get("heading", "")), vocab)
        bullets = _scrub_all([str(b) for b in section.get("bullets", [])], vocab)  # type: ignore[union-attr]
        if not heading or not bullets:
            continue
        out.append({"heading": heading, "bullets": bullets})
    return out


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
    "topic, in the order it was said}. Attribute statements to a speaker by "
    "name ONLY when the transcript itself gives that speaker's name (e.g. "
    '"Collins Kipkorir explains …"). Where a turn is only labelled '
    '"Speaker 1", write about it without a name — say "one participant" or '
    "just describe what was said. Never invent, guess or substitute a name.\n"
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
    "takeaways, decisions and facts). Do not invent anything. Refer to people "
    "by name only where the notes name them; otherwise describe them by role "
    "or as participants. Never invent or guess a person's name."
)

_INSIGHTS_SYSTEM = (
    "You are a meeting-notes assistant. From the notes below, reply with ONLY a "
    "JSON object with exactly two fields:\n"
    '  "action_items": an array of 0-10 strings. Each one is a task somebody '
    "agreed to DO after the meeting. Start each with a verb and include enough "
    "detail to act on it. A topic that was merely discussed is NOT an action "
    "item — if nobody committed to anything, return an empty array.\n"
    "  Attribute a task to an owner ONLY when the notes explicitly state who "
    "took it on, and then use that person's exact name from the notes in "
    "parentheses at the end. If the notes do not say who owns a task, write the "
    "task with NO owner and no parentheses at all — an unowned task is correct "
    "and expected. Never guess an owner, never use a placeholder or example "
    "name, and never reuse one task's owner on another task.\n"
    '  "insights": an array of 2-5 objects {"heading": a short theme, '
    '"bullets": array of 2-5 short factual sentences}. Group related facts '
    "under each theme; never emit a theme with only one bullet. Choose only "
    "themes the conversation actually covers — for example Decisions, "
    "Risks & blockers, Open questions, Numbers & pricing, Tools & systems, "
    "Timeline. Do not invent anything.\n"
    "Use only names that literally appear in the notes. Never introduce a "
    "person who is not named there.\n"
    "Example of the shape and level of detail expected — note that neither task "
    "carries an owner, because the notes behind them named nobody:\n"
    '{"action_items": ["Provision a free sandbox account for the client team '
    'so they can test the product", "Confirm which vector database '
    'the agent system uses and send the technical details"], '
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

    # Names the transcript actually contains. Anything the model attributes to
    # someone outside this set is an invention and gets stripped below.
    vocab = _vocabulary(transcript)

    chunks = _chunk(transcript, CHUNK_CHARS)
    notes_lines: List[str] = []
    outline: List[Dict[str, object]] = []
    for i, chunk in enumerate(chunks):
        mapped = _map_chunk(chunk, i + 1, len(chunks))
        # Scrub here, not just at the end: the notes are the reduce step's input,
        # so a name invented now would otherwise propagate into every section.
        notes_lines.extend(
            _scrub_all([str(n) for n in mapped["notes"]], vocab)  # type: ignore[union-attr]
        )
        outline.extend(_scrub_sections(mapped["sections"], vocab))  # type: ignore[arg-type]
        # The map step is the bulk of the work; give it 70% of the progress bar.
        report(0.7 * (i + 1) / len(chunks), f"Reading part {i + 1} of {len(chunks)}")

    outline = _merge_sections(outline)
    notes = "\n".join(f"- {line}" for line in notes_lines) or transcript

    overview_parsed = _chat_json(_OVERVIEW_SYSTEM, f"Notes:\n\n{notes}")
    summary = _scrub_names(str(overview_parsed.get("summary", "")).strip(), vocab)
    key_points = _scrub_all(
        _strings(overview_parsed.get("key_points", []), limit=12), vocab
    )
    report(0.85, "Writing the overview")

    insights_parsed = _chat_json(_INSIGHTS_SYSTEM, f"Notes:\n\n{notes}")
    action_items = _scrub_all(
        _strings(insights_parsed.get("action_items", []), limit=12), vocab
    )
    insights = _scrub_sections(
        _sections(insights_parsed.get("insights", []), limit=6), vocab
    )
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
# Business record — the SOP's source text
# ---------------------------------------------------------------------------

_BUSINESS_INTRO = (
    "You are writing the business record of a meeting from a transcript that "
    "has already had its filler and its small talk removed. A Standard "
    "Operating Procedure will be written from this record later, so procedural "
    "detail matters far more than brevity.\n"
)

# What the record must contain, shared by both request shapes below.
_BUSINESS_CONTENT = (
    "Set out, in the order the work happens:\n"
    "   - what work, process or task is being described, and why;\n"
    "   - each step involved and who carries it out;\n"
    "   - the systems, tools, documents and data used at each step;\n"
    "   - the rules, conditions, approvals and exceptions that apply;\n"
    "   - every number, amount, date, deadline and identifier mentioned;\n"
    "   - what was decided or agreed, and what remains a problem, blocker or "
    "open question.\n"
    "Write plain prose paragraphs, not bullet lists and not dialogue. Do not "
    "summarise the specifics away: keep exact figures, system names and the "
    "precise wording of any rule or condition. Include nothing that is not in "
    "the transcript. Never invent a person's name — name someone only where the "
    "transcript names them, and otherwise describe them by role or as a "
    "participant."
)

_BUSINESS_SYSTEM = (
    _BUSINESS_INTRO
    + "Reply with ONLY a JSON object with one field:\n"
    '  "paragraphs": an array of 2-6 paragraphs of 3-6 sentences each.\n'
    + _BUSINESS_CONTENT
)

# Fallback shape. A small model asked for a long JSON string can run out of
# room and truncate mid-value, which is unparseable and costs the whole record;
# plain prose has no such failure mode.
_BUSINESS_PROSE_SYSTEM = (
    _BUSINESS_INTRO
    + "Reply with 2-6 paragraphs of 3-6 sentences each as plain text, with a "
    "blank line between paragraphs. No JSON, no headings, no bullet points.\n"
    + _BUSINESS_CONTENT
)

# JSON attempts before falling back to prose. Retrying is worth it because the
# failure is usually a one-off malformed reply, not a refusal.
_BUSINESS_ATTEMPTS = 2


def _business_paragraphs(label: str, chunk: str, vocab: set) -> List[str]:
    """One chunk's paragraphs, retried and then re-asked as plain prose."""
    user = f"{label}:\n\n{chunk}"
    for _ in range(_BUSINESS_ATTEMPTS):
        parsed = _chat_json(_BUSINESS_SYSTEM, user)
        found = _scrub_all(_strings(parsed.get("paragraphs", []), limit=12), vocab)
        if found:
            return found
        print("[summarization] business record reply unusable; retrying")

    prose = _chat(_BUSINESS_PROSE_SYSTEM, user)
    return _scrub_all(
        [para.strip() for para in re.split(r"\n{2,}", prose) if para.strip()], vocab
    )


def summarize_business(transcript: str, *, on_progress: FractionFn = None) -> str:
    """Write the detailed business record for a business-only transcript.

    Takes the small-talk-free tier of the transcript and returns prose
    paragraphs separated by blank lines. Raises SummaryUnavailable when there is
    nothing to work from or the model returns nothing usable.

    Long inputs are handled chunk by chunk and the results concatenated, rather
    than reduced into one pass — a second reduction is exactly what throws away
    the procedural detail the SOP needs.
    """
    transcript = (transcript or "").strip()
    if not _is_meaningful(transcript):
        raise SummaryUnavailable("No business content to write a record from.")

    vocab = _vocabulary(transcript)
    chunks = _chunk(transcript, CHUNK_CHARS)
    paragraphs: List[str] = []
    for i, chunk in enumerate(chunks):
        label = (
            f"Business transcript part {i + 1} of {len(chunks)}"
            if len(chunks) > 1
            else "Business transcript"
        )
        paragraphs.extend(_business_paragraphs(label, chunk, vocab))
        if on_progress:
            on_progress((i + 1) / len(chunks))

    if not paragraphs:
        raise SummaryUnavailable("Model returned an empty business record.")
    return "\n\n".join(paragraphs)


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
