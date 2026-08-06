"""Standard Operating Procedure generation, from the cleaned transcript.

The tail end of the text pipeline. By the time this runs, ``cleaning.py`` has
stripped the fillers, ``relevance.py`` has set the small talk aside,
``rewrite.py`` has repaired the wording and ``summarization.py`` has written the
**business record** — a prose account of the work discussed. This module turns
that record into a numbered SOP laid out like a company policy document:

    1. PURPOSE            why the procedure exists
    2. SCOPE              who it applies to
    3. DEFINITIONS        the terms the conversation used
    4. PROCEDURE          the steps, in the order the work happens
    5. RESPONSIBILITIES   who carries out what
    6. MONITORING AND ENFORCEMENT
    7. OPEN ITEMS AND REVIEW   what was left unresolved

**Generation is never automatic.** Most conversations are not procedural, and an
SOP written from a chat about the weather is worse than no SOP at all — so the
user asks for one per recording. ``assess()`` gives the UI what it needs to make
that a informed choice (how much business content survived the small-talk pass)
without spending a single model token; the model itself gets a second veto,
returning ``applicable: false`` when the transcript describes no repeatable
process, and that comes back to the caller as ``SopUnavailable``.

Two model calls, not one: the document's spine (title, purpose, scope,
definitions) and then its body (procedure, responsibilities, monitoring, open
items). A small local model asked for one large JSON object routinely runs out of
room and truncates mid-value, which costs the whole document; two smaller replies
either parse or fail independently. Long sources are condensed to procedural
notes first, chunk by chunk, so nothing in the middle is lost.

Every generated string goes through the same invented-name guard the notes use
(``summarization._scrub_names``): an SOP that assigns a step to somebody who was
never in the room is a liability, not a document.

Rendering is done here too, so the .txt and the .pdf are always the same
document: ``render_text`` for the plain-text copy, ``render_pdf`` for the
formatted one (reportlab — optional; ``pdf_available()`` says whether it is
installed).

Config (env / .env):
  * SOP                  — "0" disables generation entirely (default on)
  * SOP_MODEL            — model to write with (default: OLLAMA_MODEL)
  * SOP_ORG              — organisation name in the header (default Techno Brain)
  * SOP_CODE_PREFIX      — document reference prefix (default TBL.SOP)
  * SOP_MIN_WORDS        — business words needed before it looks worthwhile (60)
  * SOP_MIN_RATIO        — business share of sentences needed likewise (0.25)
  * SOP_SOURCE_CHARS     — source characters before a condensing pass runs (9000)
"""

from __future__ import annotations

import os
import re
import textwrap
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

import summarization

ENABLED = os.environ.get("SOP", "1") in ("1", "true", "True")
MODEL = os.environ.get("SOP_MODEL") or summarization.OLLAMA_MODEL

ORG_NAME = os.environ.get("SOP_ORG", "Techno Brain")
CODE_PREFIX = os.environ.get("SOP_CODE_PREFIX", "TBL.SOP")

# What "enough to write a procedure from" means. Both are deliberately generous:
# this only decides which of two prompts the UI shows, and the user can always
# generate anyway.
MIN_BUSINESS_WORDS = int(os.environ.get("SOP_MIN_WORDS", "60"))
MIN_BUSINESS_RATIO = float(os.environ.get("SOP_MIN_RATIO", "0.25"))

# Above this many characters the source is condensed to procedural notes first,
# rather than being truncated — the end of a long meeting is usually where the
# decisions are.
SOURCE_CHARS = int(os.environ.get("SOP_SOURCE_CHARS", "9000"))

# JSON attempts per call before giving up on it. Same reasoning as the business
# record's retry: a malformed reply is usually a one-off, not a refusal.
ATTEMPTS = 2

SMALL_TALK = "smalltalk"
UNTITLED = "Untitled procedure"

ProgressFn = Optional[Callable[[float, str], None]]


class SopUnavailable(RuntimeError):
    """No SOP could be written — model unreachable, or nothing to document."""


# ---------------------------------------------------------------------------
# Is this recording worth an SOP? (heuristic — no model, instant)
# ---------------------------------------------------------------------------


def _segment_business(seg: Dict[str, Any]) -> str:
    """The business-only text of one stored segment.

    Falls through the tiers the same way the transcript UI does, so a recording
    saved before the relevance pass existed still yields its text.
    """
    relevant = seg.get("relevant")
    if isinstance(relevant, str):
        return relevant.strip()

    sentences = seg.get("sentences") or []
    if sentences:
        return " ".join(
            (s.get("clean") or "").strip()
            for s in sentences
            if s.get("label") != SMALL_TALK and (s.get("clean") or "").strip()
        ).strip()

    return (seg.get("clean") or seg.get("raw") or "").strip()


def business_transcript(recording: Dict[str, Any]) -> str:
    """Speaker-labelled transcript of the business content only."""
    speakers = {
        s.get("id"): s.get("name") or "Speaker"
        for s in recording.get("speakers") or []
        if isinstance(s, dict)
    }
    lines: List[str] = []
    for seg in recording.get("segments") or []:
        if not isinstance(seg, dict):
            continue
        text = _segment_business(seg)
        if text:
            name = speakers.get(seg.get("speakerId"), "Speaker")
            lines.append(f"{name}: {text}")
    return "\n\n".join(lines)


def source_text(recording: Dict[str, Any]) -> Tuple[str, str]:
    """The text an SOP gets written from, and a label saying where it came from.

    The business record is the intended source — it is already prose, already
    small-talk-free and written to keep procedural detail. The cleaned
    transcript is the fallback for recordings made before the record existed, or
    where the summarizer was unreachable at the time.
    """
    record = (recording.get("businessSummary") or "").strip()
    if len(record.split()) >= 40:
        return record, "the business record"

    transcript = business_transcript(recording)
    if record and len(record) > len(transcript):
        return record, "the business record"
    return transcript, "the cleaned transcript"


def assess(recording: Dict[str, Any]) -> Dict[str, Any]:
    """How much business content this recording has, and whether it looks worth
    documenting. Cheap enough to call on every render of the SOP tab.

    ``suitable`` is advice, not a gate: the endpoint will generate whatever the
    user asks for. It exists so the UI can warn before spending a few minutes of
    local-model time on a conversation that was all small talk.
    """
    small = 0
    total = 0
    for seg in recording.get("segments") or []:
        if not isinstance(seg, dict):
            continue
        for sentence in seg.get("sentences") or []:
            total += 1
            if sentence.get("label") == SMALL_TALK:
                small += 1

    text, label = source_text(recording)
    words = len(text.split())
    business = total - small
    # Unlabelled recordings (pre-relevance-pass) get the benefit of the doubt:
    # there is no evidence of small talk, so don't invent a low ratio.
    ratio = (business / total) if total else 1.0

    if not ENABLED:
        suitable, reason = False, "SOP generation is switched off on the server."
    elif words < MIN_BUSINESS_WORDS:
        suitable = False
        reason = (
            f"Only {words} words of business content survived the small-talk "
            "pass — there is probably no procedure here to document."
        )
    elif ratio < MIN_BUSINESS_RATIO:
        suitable = False
        reason = (
            f"Most of this conversation was small talk ({small} of {total} "
            "sentences), so an SOP may come out thin."
        )
    else:
        suitable = True
        reason = (
            f"{words} words of business content"
            + (f" across {business} of {total} sentences" if total else "")
            + f", taken from {label}."
        )

    return {
        "suitable": suitable,
        "reason": reason,
        "available": ENABLED,
        "pdf": pdf_available(),
        "businessWords": words,
        "businessRatio": round(ratio, 3),
        "smallTalk": small,
        "sentences": total,
        "source": label,
        "hasRecord": bool((recording.get("businessSummary") or "").strip()),
        "hasSop": bool(recording.get("sop")),
        "model": MODEL,
    }


# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

_GROUND_RULES = (
    "Use ONLY what the source says. Never invent a step, a rule, a figure, a "
    "system or a person. Name a person only where the source names them, and "
    "otherwise refer to them by role ('the requester', 'the approver') or as a "
    "participant. Keep every figure, amount, date, deadline, system name and "
    "identifier exactly as written. Write in the flat, instructional voice of a "
    "company policy document — no marketing language, no praise, no commentary "
    "about the meeting itself, and no mention of a transcript or a recording."
)

# Call 1 — the document's spine. `applicable` is the model's veto: it sees the
# content and can say there is no repeatable process here to write down.
_SPINE_SYSTEM = (
    "You are a policy writer turning a record of a work discussion into a "
    "Standard Operating Procedure.\n"
    "First decide whether the source actually describes a repeatable process, "
    "task or set of rules that an SOP could document. A social conversation, a "
    "one-off chat or a discussion with no procedure in it is NOT applicable.\n"
    "Reply with ONLY a JSON object with these fields:\n"
    '  "applicable": true or false.\n'
    '  "reason": one sentence explaining that decision.\n'
    '  "title": the procedure\'s name, e.g. "Client Onboarding Procedure". '
    "Title case, no more than 10 words.\n"
    '  "purpose": one paragraph of 2-4 sentences saying what the procedure is '
    "for and what it achieves.\n"
    '  "scope": an array of 2-5 short strings saying who and what it applies '
    "to (roles, teams, systems, the kinds of case covered).\n"
    '  "definitions": an array of 0-6 objects {"term": short term used in the '
    'source, "meaning": one-sentence explanation}. Define only terms, systems '
    "or abbreviations the source itself uses. Return an empty array if there "
    "are none.\n"
    "If applicable is false, still return the other fields as empty strings and "
    "empty arrays.\n" + _GROUND_RULES
)

# Call 2 — the body. Kept separate so a truncated reply costs the procedure, not
# the whole document.
_BODY_SYSTEM = (
    "You are a policy writer turning a record of a work discussion into a "
    "Standard Operating Procedure. The document's purpose and scope are already "
    "written; produce its body.\n"
    "Reply with ONLY a JSON object with these fields:\n"
    '  "sections": an array of 2-6 objects {"heading": short title for this '
    'stage of the work, "body": optional one-or-two-sentence introduction, '
    '"bullets": array of 2-8 instruction strings}. Order the sections the way '
    "the work happens. Write each bullet as an instruction beginning with a "
    "verb ('Confirm the client's billing details in the CRM before …'), and say "
    "which system, document or figure it uses. Put the conditions, approvals, "
    "thresholds and exceptions in the section they apply to.\n"
    '  "responsibilities": an array of 0-6 objects {"role": who, "duty": what '
    "they are responsible for}. Use job titles or roles, not personal names, "
    "unless the source names the person.\n"
    '  "monitoring": one paragraph of 1-3 sentences on how compliance is '
    "checked, recorded or escalated. Return an empty string if the source says "
    "nothing about it — do not invent an enforcement regime.\n"
    '  "openItems": an array of 0-6 strings: the questions left unanswered, the '
    "blockers, and the decisions still owed. Empty array if there are none.\n"
    + _GROUND_RULES
)

# Condensing pass for a long source. Notes, not a summary: the SOP is written
# from these, so losing the specifics here loses them for good.
_CONDENSE_SYSTEM = (
    "You are extracting the procedural content from one part of a record of a "
    "work discussion, so that a Standard Operating Procedure can be written "
    "from it.\n"
    'Reply with ONLY a JSON object with one field: "notes", an array of terse '
    "bullet strings. Capture every step of the work and its order, who does it, "
    "the systems and documents used, every rule, condition, approval, threshold "
    "and exception, every figure, amount, date and identifier, and anything "
    "left unresolved. Leave out anything that is not about how the work is "
    "done. " + _GROUND_RULES
)


# ---------------------------------------------------------------------------
# Generation
# ---------------------------------------------------------------------------


def _pairs(value: object, first: str, second: str, *, limit: int = 8) -> List[Dict[str, str]]:
    """Coerce a model-produced list into ``[{first: …, second: …}]`` entries."""
    if not isinstance(value, list):
        return []
    out: List[Dict[str, str]] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        a = str(item.get(first) or "").strip()
        b = str(item.get(second) or "").strip()
        if not a or not b:
            continue
        out.append({first: a, second: b})
        if len(out) >= limit:
            break
    return out


def _grounded(label: str, vocab: set) -> bool:
    """Is this label's capitalised wording actually present in the source?

    ``summarization._scrub_names`` only strips a name where the grammar marks it
    as one — "assign it to Priscilla", "Priscilla will confirm". A bare label in
    a table ("Priscilla — approves the credit limit") gives it nothing to go on,
    and the responsibilities table is exactly where a small model invents a
    person. So a label has to be *grounded*: at least one of its capitalised
    words must appear in the source.

    Deliberately "at least one", not "all": the source saying "finance" is
    enough to accept "Finance Manager", while "Priscilla" — with nothing behind
    it — is dropped. A label with no capitalised words at all ("account
    manager") is ordinary prose and always passes.
    """
    tokens = summarization._PERSON_TOKEN_RE.findall(label)
    if not tokens:
        return True
    return any(token.lower() in vocab for token in tokens)


def _scrub_pairs(pairs: List[Dict[str, str]], keys: Tuple[str, str], vocab: set) -> List[Dict[str, str]]:
    """Scrub both halves of each pair, and drop pairs whose label is invented."""
    out: List[Dict[str, str]] = []
    dropped = 0
    for pair in pairs:
        a = summarization._scrub_names(pair[keys[0]], vocab)
        b = summarization._scrub_names(pair[keys[1]], vocab)
        if not (a and b):
            continue
        if not _grounded(a, vocab):
            dropped += 1
            continue
        out.append({keys[0]: a, keys[1]: b})
    if dropped:
        print(f"[sop] dropped {dropped} {keys[0]} entr(y/ies) naming nobody in the source")
    return out


def _condense(text: str, vocab: set, report: Callable[[float, str], None]) -> str:
    """Reduce an over-long source to procedural notes, chunk by chunk."""
    chunks = summarization._chunk(text, summarization.CHUNK_CHARS)
    notes: List[str] = []
    for i, chunk in enumerate(chunks):
        label = f"Source part {i + 1} of {len(chunks)}"
        parsed = summarization._chat_json(
            _CONDENSE_SYSTEM, f"{label}:\n\n{chunk}", model=MODEL
        )
        notes.extend(
            summarization._scrub_all(
                summarization._strings(parsed.get("notes", []), limit=60), vocab
            )
        )
        report(0.5 * (i + 1) / len(chunks), f"Reading part {i + 1} of {len(chunks)}")
    if not notes:
        # Nothing usable came back — the raw source is still better than nothing.
        return text[:SOURCE_CHARS]
    return "\n".join(f"- {line}" for line in notes)


def _spine(source: str, vocab: set) -> Dict[str, Any]:
    """Title, purpose, scope and definitions — plus the model's applicability veto."""
    user = f"Source:\n\n{source}"
    for _ in range(ATTEMPTS):
        parsed = summarization._chat_json(_SPINE_SYSTEM, user, model=MODEL)
        title = summarization._scrub_names(str(parsed.get("title") or "").strip(), vocab)
        purpose = summarization._scrub_names(str(parsed.get("purpose") or "").strip(), vocab)
        applicable = parsed.get("applicable")
        reason = str(parsed.get("reason") or "").strip()

        # An explicit "no" is an answer, not a failure — hand it back at once.
        if applicable is False:
            return {"applicable": False, "reason": reason}

        if title or purpose:
            return {
                "applicable": True,
                "reason": reason,
                "title": title,
                "purpose": purpose,
                "scope": summarization._scrub_all(
                    summarization._strings(parsed.get("scope", []), limit=6), vocab
                ),
                "definitions": _scrub_pairs(
                    _pairs(parsed.get("definitions", []), "term", "meaning"),
                    ("term", "meaning"),
                    vocab,
                ),
            }
        print("[sop] spine reply unusable; retrying")
    raise SopUnavailable("The model returned nothing usable for the SOP header.")


def _body(source: str, spine: Dict[str, Any], vocab: set) -> Dict[str, Any]:
    """Procedure sections, responsibilities, monitoring and open items."""
    user = (
        f"Procedure title: {spine.get('title') or UNTITLED}\n"
        f"Purpose: {spine.get('purpose') or '(not stated)'}\n\n"
        f"Source:\n\n{source}"
    )
    for _ in range(ATTEMPTS):
        parsed = summarization._chat_json(_BODY_SYSTEM, user, model=MODEL)
        sections = summarization._scrub_sections(
            summarization._sections(parsed.get("sections", []), limit=8), vocab
        )
        if sections:
            return {
                "sections": sections,
                "responsibilities": _scrub_pairs(
                    _pairs(parsed.get("responsibilities", []), "role", "duty"),
                    ("role", "duty"),
                    vocab,
                ),
                "monitoring": summarization._scrub_names(
                    str(parsed.get("monitoring") or "").strip(), vocab
                ),
                "openItems": summarization._scrub_all(
                    summarization._strings(parsed.get("openItems", []), limit=8), vocab
                ),
            }
        print("[sop] body reply unusable; retrying")
    raise SopUnavailable("The model returned no procedure steps.")


def _document_code(title: str, recording_id: str) -> str:
    """A stable-looking document reference, e.g. ``TBL.SOP.CLIENT.4A2F``.

    Derived, not sequential: nothing here owns a document register, so pretending
    to issue numbers would be a lie. The slug is the title's first real word and
    the suffix comes from the recording id, so the same recording always gets the
    same reference.
    """
    words = [w for w in re.findall(r"[A-Za-z]+", title) if len(w) > 3]
    slug = (words[0][:8] if words else "GEN").upper()
    tail = re.sub(r"[^0-9a-fA-F]", "", recording_id)[:4].upper() or "0001"
    return f"{CODE_PREFIX}.{slug}.{tail}"


def generate(recording: Dict[str, Any], *, on_progress: ProgressFn = None) -> Dict[str, Any]:
    """Write the SOP for a stored recording.

    Returns the document as a dict (the shape the frontend and the renderers
    both read). Raises ``SopUnavailable`` when the model is unreachable, returns
    nothing usable, or judges that the conversation describes no procedure —
    which is a legitimate outcome, not an error to paper over.
    """
    if not ENABLED:
        raise SopUnavailable("SOP generation is disabled on this server (SOP=0).")

    def report(fraction: float, label: str) -> None:
        if on_progress:
            on_progress(fraction, label)

    source, source_label = source_text(recording)
    if len(source.split()) < 20:
        raise SopUnavailable(
            "There is not enough business content in this recording to write a "
            "procedure from."
        )

    # Names the source actually contains; anything else the model attributes to
    # a person is an invention and gets stripped out below.
    vocab = summarization._vocabulary(source)

    report(0.05, "Reading the business record")
    if len(source) > SOURCE_CHARS:
        source = _condense(source, vocab, report)

    report(0.55, "Drafting purpose and scope")
    spine = _spine(source, vocab)
    if not spine.get("applicable", True):
        raise SopUnavailable(
            spine.get("reason")
            or "This conversation does not describe a repeatable procedure."
        )

    report(0.75, "Writing the procedure")
    body = _body(source, spine, vocab)
    report(1.0, "Formatting the document")

    title = spine.get("title") or (recording.get("title") or "Untitled").strip()
    sop = {
        "title": title,
        "code": _document_code(title, str(recording.get("id") or "")),
        "purpose": spine.get("purpose", ""),
        "scope": spine.get("scope", []),
        "definitions": spine.get("definitions", []),
        "sections": body["sections"],
        "responsibilities": body["responsibilities"],
        "monitoring": body["monitoring"],
        "openItems": body["openItems"],
        # Provenance, shown in the document header and the UI. Draft on purpose:
        # a machine-written procedure is a starting point for review.
        "status": "Draft",
        "organisation": ORG_NAME,
        "source": source_label,
        "model": MODEL,
        "generatedAt": int(time.time() * 1000),
        "edited": False,
    }
    print(
        f"[sop] '{title}' — {len(sop['sections'])} sections, "
        f"{len(sop['scope'])} scope lines, from {source_label} ({MODEL})"
    )
    return sop


def sanitize(payload: Dict[str, Any], previous: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Coerce a user-edited SOP back into the stored shape.

    The editor in the UI is free-form text, so everything here is re-validated:
    unknown keys are dropped, lists are re-coerced, and the provenance fields
    (code, model, when it was generated) are carried over from the stored
    document rather than taken from the client.
    """
    prior = previous or {}
    sections: List[Dict[str, Any]] = []
    for section in payload.get("sections") or []:
        if not isinstance(section, dict):
            continue
        heading = str(section.get("heading") or "").strip()
        body = str(section.get("body") or "").strip()
        bullets = summarization._strings(section.get("bullets") or [], limit=20)
        if heading or body or bullets:
            sections.append({"heading": heading, "body": body, "bullets": bullets})

    title = str(payload.get("title") or prior.get("title") or UNTITLED).strip()
    return {
        "title": title,
        "code": str(prior.get("code") or _document_code(title, "")),
        "purpose": str(payload.get("purpose") or "").strip(),
        "scope": summarization._strings(payload.get("scope") or [], limit=12),
        "definitions": _pairs(payload.get("definitions") or [], "term", "meaning", limit=12),
        "sections": sections,
        "responsibilities": _pairs(
            payload.get("responsibilities") or [], "role", "duty", limit=12
        ),
        "monitoring": str(payload.get("monitoring") or "").strip(),
        "openItems": summarization._strings(payload.get("openItems") or [], limit=12),
        "status": str(prior.get("status") or "Draft"),
        "organisation": str(prior.get("organisation") or ORG_NAME),
        "source": str(prior.get("source") or ""),
        "model": str(prior.get("model") or MODEL),
        "generatedAt": int(prior.get("generatedAt") or int(time.time() * 1000)),
        "editedAt": int(time.time() * 1000),
        "edited": True,
    }


# ---------------------------------------------------------------------------
# The document's parts, in order — shared by both renderers so the .txt and the
# .pdf can never drift apart. An empty part is dropped, and the numbering is
# assigned afterwards, so a document with no definitions doesn't skip a number.
# ---------------------------------------------------------------------------


def _parts(sop: Dict[str, Any]) -> List[Dict[str, Any]]:
    parts: List[Dict[str, Any]] = []

    def add(heading: str, **kind: Any) -> None:
        parts.append({"heading": heading, **kind})

    if (sop.get("purpose") or "").strip():
        add("PURPOSE", paragraph=sop["purpose"].strip())
    if sop.get("scope"):
        add("SCOPE", bullets=list(sop["scope"]))
    if sop.get("definitions"):
        add(
            "DEFINITIONS",
            pairs=[(d["term"], d["meaning"]) for d in sop["definitions"]],
        )
    if sop.get("sections"):
        add("PROCEDURE", sections=list(sop["sections"]))
    if sop.get("responsibilities"):
        add(
            "RESPONSIBILITIES",
            pairs=[(r["role"], r["duty"]) for r in sop["responsibilities"]],
        )
    if (sop.get("monitoring") or "").strip():
        add("MONITORING AND ENFORCEMENT", paragraph=sop["monitoring"].strip())
    if sop.get("openItems"):
        add("OPEN ITEMS AND REVIEW", bullets=list(sop["openItems"]))

    for i, part in enumerate(parts, start=1):
        part["number"] = i
    return parts


def _meta_lines(sop: Dict[str, Any], recording: Dict[str, Any]) -> List[Tuple[str, str]]:
    """The header block: where this document came from and how far to trust it."""
    generated = sop.get("generatedAt")
    stamp = (
        time.strftime("%d %b %Y %H:%M", time.localtime(generated / 1000))
        if isinstance(generated, (int, float)) and generated
        else "—"
    )
    lines = [
        ("Document ref", str(sop.get("code") or "—")),
        ("Status", str(sop.get("status") or "Draft")),
        ("Source recording", str(recording.get("title") or recording.get("fileName") or "—")),
        ("Generated", f"{stamp} · {sop.get('model') or 'local model'}"),
    ]
    if sop.get("edited"):
        edited = sop.get("editedAt")
        when = (
            time.strftime("%d %b %Y %H:%M", time.localtime(edited / 1000))
            if isinstance(edited, (int, float)) and edited
            else "—"
        )
        lines.append(("Edited", when))
    return lines


_DISCLAIMER = (
    "Drafted automatically from a meeting transcript. Review and approve it "
    "before it is issued or relied upon."
)


# ---------------------------------------------------------------------------
# Plain text
# ---------------------------------------------------------------------------

_WIDTH = 78
_INDENT = "    "


def _wrap(text: str, indent: str = _INDENT, hanging: Optional[str] = None) -> List[str]:
    return textwrap.wrap(
        " ".join(text.split()),
        width=_WIDTH,
        initial_indent=indent,
        subsequent_indent=hanging if hanging is not None else indent,
    ) or [indent.rstrip()]


def render_text(sop: Dict[str, Any], recording: Dict[str, Any]) -> str:
    """The SOP as a plain-text document, laid out like the policy PDFs."""
    org = str(sop.get("organisation") or ORG_NAME).upper()
    out: List[str] = [
        org,
        "STANDARD OPERATING PROCEDURE",
        "=" * _WIDTH,
        "",
        str(sop.get("title") or UNTITLED).upper(),
        "",
    ]

    meta = _meta_lines(sop, recording)
    width = max(len(label) for label, _ in meta)
    for label, value in meta:
        out.append(f"{label.ljust(width)}  :  {value}")
    out += ["", "-" * _WIDTH, ""]

    for part in _parts(sop):
        out.append(f"{part['number']}. {part['heading']}")
        out.append("")

        if "paragraph" in part:
            out += _wrap(part["paragraph"])
            out.append("")

        for bullet in part.get("bullets", []):
            out += _wrap(f"- {bullet}", indent=_INDENT, hanging=_INDENT + "  ")
        if part.get("bullets"):
            out.append("")

        for term, meaning in part.get("pairs", []):
            out += _wrap(f"{term} — {meaning}", indent=_INDENT, hanging=_INDENT + "  ")
            out.append("")

        for n, section in enumerate(part.get("sections", []), start=1):
            out.append(f"{_INDENT}{part['number']}.{n} {section.get('heading', '')}".rstrip())
            out.append("")
            if (section.get("body") or "").strip():
                out += _wrap(section["body"], indent=_INDENT * 2)
                out.append("")
            for bullet in section.get("bullets") or []:
                out += _wrap(
                    f"- {bullet}", indent=_INDENT * 2, hanging=_INDENT * 2 + "  "
                )
            if section.get("bullets"):
                out.append("")

    out += ["-" * _WIDTH]
    out += _wrap(_DISCLAIMER, indent="")
    return "\n".join(out).rstrip() + "\n"


# ---------------------------------------------------------------------------
# PDF (reportlab — optional)
# ---------------------------------------------------------------------------

_ACCENT = "#e8730c"  # the orange used on the policy documents' headers
_INK = "#1a1a1a"
_MUTED = "#5b5b66"


def pdf_available() -> bool:
    """Whether reportlab is installed, so the UI can hide the PDF button."""
    try:
        import reportlab  # noqa: F401
    except ImportError:
        return False
    return True


def render_pdf(sop: Dict[str, Any], recording: Dict[str, Any]) -> bytes:
    """The same document as a formatted PDF. Raises SopUnavailable without reportlab."""
    try:
        from reportlab.lib.colors import HexColor
        from reportlab.lib.enums import TA_JUSTIFY
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.lib.units import mm
        from reportlab.platypus import (
            KeepTogether,
            ListFlowable,
            ListItem,
            Paragraph,
            SimpleDocTemplate,
            Spacer,
            Table,
            TableStyle,
        )
    except ImportError as exc:  # pragma: no cover - depends on the install
        raise SopUnavailable(
            "PDF export needs reportlab: pip install reportlab (the .txt "
            "download works without it)."
        ) from exc

    import io

    accent, ink, muted = HexColor(_ACCENT), HexColor(_INK), HexColor(_MUTED)
    title = str(sop.get("title") or UNTITLED)
    org = str(sop.get("organisation") or ORG_NAME)

    def escape(text: object) -> str:
        return (
            str(text)
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
        )

    body = ParagraphStyle(
        "body",
        fontName="Helvetica",
        fontSize=9.5,
        leading=14,
        textColor=ink,
        alignment=TA_JUSTIFY,
    )
    heading = ParagraphStyle(
        "heading",
        parent=body,
        fontName="Helvetica-Bold",
        fontSize=11,
        leading=15,
        alignment=0,
        spaceBefore=10,
        spaceAfter=5,
    )
    subheading = ParagraphStyle(
        "subheading", parent=heading, fontSize=9.8, spaceBefore=7, spaceAfter=3
    )
    bullet = ParagraphStyle("bullet", parent=body, leftIndent=6, spaceAfter=3)
    doc_title = ParagraphStyle(
        "doc_title",
        parent=body,
        fontName="Helvetica-Bold",
        fontSize=15,
        leading=19,
        alignment=0,
        textColor=ink,
        spaceAfter=2,
    )
    meta_label = ParagraphStyle(
        "meta_label", parent=body, fontSize=8, leading=11, textColor=muted, alignment=0
    )
    meta_value = ParagraphStyle(
        "meta_value", parent=meta_label, fontName="Helvetica-Bold", textColor=ink
    )
    footnote = ParagraphStyle(
        "footnote", parent=body, fontSize=7.6, leading=10.5, textColor=muted, alignment=0
    )

    def header_footer(canvas, doc) -> None:
        """The banner every page carries — org left, document name in an orange box."""
        canvas.saveState()
        top = A4[1] - 14 * mm
        canvas.setFillColor(accent)
        canvas.rect(20 * mm, top - 1.6 * mm, 3.6 * mm, 3.6 * mm, stroke=0, fill=1)
        canvas.setFillColor(ink)
        canvas.setFont("Helvetica-Bold", 11)
        canvas.drawString(25 * mm, top - 1 * mm, org.upper())

        label = "STANDARD OPERATING PROCEDURE"
        canvas.setFont("Helvetica-Bold", 7.6)
        text_width = canvas.stringWidth(label, "Helvetica-Bold", 7.6)
        box_width = text_width + 8 * mm
        box_x = A4[0] - 20 * mm - box_width
        canvas.setStrokeColor(accent)
        canvas.setLineWidth(0.7)
        canvas.rect(box_x, top - 3.4 * mm, box_width, 7 * mm, stroke=1, fill=0)
        canvas.setFillColor(accent)
        canvas.drawString(box_x + 4 * mm, top - 1 * mm, label)

        canvas.setStrokeColor(HexColor("#d8d8de"))
        canvas.setLineWidth(0.5)
        canvas.line(20 * mm, top - 7 * mm, A4[0] - 20 * mm, top - 7 * mm)

        canvas.setFillColor(muted)
        canvas.setFont("Helvetica", 7.4)
        canvas.drawString(20 * mm, 12 * mm, f"{sop.get('code') or ''}  ·  {title}")
        canvas.drawRightString(A4[0] - 20 * mm, 12 * mm, f"Page {doc.page}")
        canvas.restoreState()

    story: List[Any] = [Paragraph(escape(title), doc_title)]

    meta = [
        [Paragraph(escape(label), meta_label), Paragraph(escape(value), meta_value)]
        for label, value in _meta_lines(sop, recording)
    ]
    table = Table(meta, colWidths=[32 * mm, None], hAlign="LEFT")
    table.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 1),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("LINEBELOW", (0, -1), (-1, -1), 0.5, HexColor("#d8d8de")),
            ]
        )
    )
    story += [Spacer(1, 3 * mm), table, Spacer(1, 4 * mm)]

    def bullets(items: List[str], style: ParagraphStyle) -> Any:
        # ZapfDingbats "n" is a filled square — the marker the policy documents
        # use — and it is one of the always-present base fonts, so the PDF stays
        # self-contained with no font embedding.
        return ListFlowable(
            [ListItem(Paragraph(escape(item), style), leftIndent=14) for item in items],
            bulletType="bullet",
            bulletFontName="ZapfDingbats",
            bulletChar="n",
            bulletColor=accent,
            bulletFontSize=4.5,
            bulletOffsetY=-3,
            leftIndent=14,
            spaceAfter=3,
        )

    pair_style = ParagraphStyle("pair", parent=body, spaceAfter=4)

    def emit(block: List[Any]) -> None:
        """Add a heading and its content, keeping the heading off a page of its own."""
        story.append(KeepTogether(block[:2]))
        story.extend(block[2:])

    for part in _parts(sop):
        block: List[Any] = [
            Paragraph(f"{part['number']}. {escape(part['heading'])}", heading)
        ]
        if "paragraph" in part:
            block.append(Paragraph(escape(part["paragraph"]), body))
        if part.get("bullets"):
            block.append(bullets(part["bullets"], bullet))
        for term, meaning in part.get("pairs", []):
            block.append(
                Paragraph(f"<b>{escape(term)}</b> — {escape(meaning)}", pair_style)
            )
        emit(block)

        for n, section in enumerate(part.get("sections", []), start=1):
            block = [
                Paragraph(
                    f"{part['number']}.{n} {escape(section.get('heading', ''))}",
                    subheading,
                )
            ]
            if (section.get("body") or "").strip():
                block.append(Paragraph(escape(section["body"]), body))
            if section.get("bullets"):
                block.append(bullets(list(section["bullets"]), bullet))
            emit(block)

    story += [Spacer(1, 6 * mm), Paragraph(escape(_DISCLAIMER), footnote)]

    buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=28 * mm,
        bottomMargin=18 * mm,
        title=title,
        author=org,
        subject="Standard Operating Procedure",
    )
    doc.build(story, onFirstPage=header_footer, onLaterPages=header_footer)
    return buffer.getvalue()


def filename(sop: Dict[str, Any], extension: str) -> str:
    """``client-onboarding-procedure-sop.pdf`` — a safe download name."""
    slug = re.sub(r"[^a-z0-9]+", "-", str(sop.get("title") or "sop").lower()).strip("-")
    return f"{slug or 'sop'}-sop.{extension}"
