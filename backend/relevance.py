"""Separate the business discussion from the small talk.

``cleaning.py`` removes *lexical* noise — "uhh", stutters, "[BLANK_AUDIO]". It
cannot touch a sentence like "Hey Neema, are you feeling cold? Switch off the
AC", which is perfectly well-formed English and completely irrelevant to the
procedure being described. Deciding that is a judgement call, so it needs a
model — and the model doing the judging is now a fine-tuned classifier of our
own rather than a prompt.

**How the verdict is reached.** ``build_dataset.py`` builds an utterance-level
small-talk/business corpus and ``finetune.py`` fine-tunes deberta-v3-small on
it; this module loads that checkpoint once and scores every sentence locally in
milliseconds. Three layers, cheapest first:

    1. a deterministic keep-override — a sentence carrying a deadline, action
       item, blocker, staffing change or client/budget reference is business
       whatever the classifier thinks, so a real decision can never be dropped;
    2. the fine-tuned classifier, keeping anything at or above KEEP_THRESHOLD;
    3. optionally (off by default) an Ollama second opinion on the slice the
       classifier is genuinely unsure about.

The point of fine-tuning was to stop paying for an LLM call per meeting, so
layer 3 stays off unless you turn it on. If the checkpoint isn't there yet — or
transformers isn't installed — the module falls back to the LLM batch
classifier it used before, so the pipeline keeps working either way.

Two rules govern this module, unchanged by the swap:

1. **Classify, never rewrite.** Every sentence keeps its exact wording; all we
   attach is a label. Nothing is deleted from storage, so the verbatim view
   stays a complete record of what was said and the UI can show precisely what
   was set aside and why. It also keeps the frontend's raw↔clean word diff
   valid, which only works because no stage invents words. (``rewrite.py``
   does rewrite — but into a separate field, downstream of here.)
2. **When unsure, keep.** Wrongly dropping a real requirement is far more
   damaging to a downstream SOP than leaving a stray pleasantry in. Anything
   the model is unsure about — and everything it fails to label at all — stays
   in the business set.

Config (env / .env):
  * RELEVANCE              — "0" disables the pass (default on)
  * RELEVANCE_BACKEND      — "auto" (default) | "model" | "llm"
  * RELEVANCE_MODEL_PATH   — fine-tuned checkpoint dir (default
                             backend/models/relevance-filter)
  * RELEVANCE_THRESHOLD    — min P(business) to keep a sentence (default 0.60)
  * RELEVANCE_DEVICE       — -1 CPU (default), 0+ = that CUDA device
  * RELEVANCE_INFER_BATCH  — sentences per forward pass (default 32)
  * RELEVANCE_ESCALATE     — "1" asks Ollama about low-confidence sentences
  * RELEVANCE_ESCALATE_BELOW — confidence under which to escalate (default 0.75)
  * RELEVANCE_MODEL        — LLM for the fallback / escalation (default OLLAMA_MODEL)
  * RELEVANCE_BATCH        — sentences per LLM request (default 30)
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import summarization

ENABLED = os.environ.get("RELEVANCE", "1") in ("1", "true", "True")

# "auto" prefers the fine-tuned classifier and falls back to the LLM; "model"
# and "llm" pin one of the two (a pinned "model" that won't load keeps
# everything rather than quietly reverting to a different judge).
BACKEND = (os.environ.get("RELEVANCE_BACKEND") or "auto").strip().lower()

MODEL_PATH = Path(
    os.environ.get("RELEVANCE_MODEL_PATH")
    or Path(__file__).resolve().with_name("models") / "relevance-filter"
)

# Lower it if real content is being dropped, raise it if small talk is leaking
# through. 0.60 leans towards keeping, matching rule 2 above.
KEEP_THRESHOLD = float(os.environ.get("RELEVANCE_THRESHOLD", "0.60"))
DEVICE = int(os.environ.get("RELEVANCE_DEVICE", "-1"))
INFER_BATCH = int(os.environ.get("RELEVANCE_INFER_BATCH", "32"))
# Matches finetune.py's MAX_LEN: sentences are short, 128 tokens is plenty.
MAX_LEN = 128

# Used by the LLM fallback and by escalation. Relevance judgement is a harder
# task than summarising, so point this at the largest instruction-tuned model
# available (llama3.1 / mistral / qwen2.5:14b).
MODEL = os.environ.get("RELEVANCE_MODEL") or summarization.OLLAMA_MODEL
BATCH = int(os.environ.get("RELEVANCE_BATCH", "30"))

ESCALATE = os.environ.get("RELEVANCE_ESCALATE", "0") in ("1", "true", "True")
ESCALATE_BELOW = float(os.environ.get("RELEVANCE_ESCALATE_BELOW", "0.75"))

BUSINESS = "business"
SMALL_TALK = "smalltalk"

ProgressFn = Optional[Callable[[float], None]]


# ---------------------------------------------------------------------------
# Deterministic keep-override
#
# The safety net under the classifier. A sentence that unambiguously carries an
# action item, deadline, blocker, staffing change or client / budget reference
# is kept even when the model is unsure about it. It is a regex, so it costs
# nothing, and it only ever flips a sentence *towards* business — it can never
# be the reason something is dropped.
# ---------------------------------------------------------------------------

_BUSINESS_SIGNALS = [
    r"\bby (mon|tue|wed|thu|fri|monday|tuesday|wednesday|thursday|friday|"
    r"eod|eow|next week|end of (day|week|month)|close of business)\b",
    r"\baction item\b", r"\bfollow[-\s]?up\b", r"\bdeadline\b", r"\bdue\b",
    r"\bblocker\b", r"\bblocked\b", r"\bsprint\b", r"\bstaging\b", r"\bdeploy\b",
    r"\brelease\b", r"\bclient\b", r"\bcustomer\b", r"\bbudget\b", r"\binvoice\b",
    r"\bcontract\b", r"\bq[1-4]\b", r"\bmilestone\b", r"\brisk\b",
    r"\bapproval\b", r"\bapprove[sd]?\b", r"\bsla\b", r"\bticket\b",
    r"\brequirement\b", r"\bsign[-\s]?off\b", r"\bescalate[sd]?\b",
    r"\b(on leave|out (today|this week|tomorrow)|sick|pto|vacation|absent)\b",
]
_BUSINESS_SIGNAL_RE = re.compile("|".join(_BUSINESS_SIGNALS), re.IGNORECASE)


def _has_business_signal(text: str) -> bool:
    return bool(_BUSINESS_SIGNAL_RE.search(text))


# ---------------------------------------------------------------------------
# The fine-tuned classifier
# ---------------------------------------------------------------------------

# Loaded once, lazily, and remembered along with *why* it couldn't load so
# /health can say so instead of the pass silently doing nothing.
_loaded: Dict[str, Any] = {"tried": False, "handle": None, "error": ""}


def _load_classifier() -> Optional[Dict[str, Any]]:
    """Load the fine-tuned checkpoint. Returns None (with a reason) if absent."""
    if _loaded["tried"]:
        return _loaded["handle"]
    _loaded["tried"] = True

    if not MODEL_PATH.exists():
        _loaded["error"] = (
            f"no fine-tuned classifier at {MODEL_PATH} — run build_dataset.py "
            "then finetune.py"
        )
        return None
    try:
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer
    except ImportError as exc:
        _loaded["error"] = f"transformers/torch not importable: {exc}"
        return None

    try:
        device = torch.device(
            f"cuda:{DEVICE}" if DEVICE >= 0 and torch.cuda.is_available() else "cpu"
        )
        tokenizer = AutoTokenizer.from_pretrained(str(MODEL_PATH))
        model = AutoModelForSequenceClassification.from_pretrained(
            str(MODEL_PATH),
            # Half precision is a GPU-only win; on CPU it is unsupported for
            # some ops and slower for the rest, so pin fp32 there.
            dtype=torch.float16 if device.type == "cuda" else torch.float32,
        )
        model.eval()
        model.to(device)
    except Exception as exc:  # noqa: BLE001 - any load failure means fall back
        _loaded["error"] = f"could not load {MODEL_PATH}: {exc}"
        return None

    # Read which logit is "business" out of the checkpoint's own label map
    # rather than assuming index 1 — a differently-ordered map would otherwise
    # invert the filter and keep exactly the wrong half of the meeting.
    label2id = {
        str(name).strip().lower(): int(idx)
        for name, idx in (model.config.label2id or {}).items()
    }
    business_id = label2id.get("business", label2id.get("1", 1))

    _loaded["handle"] = {
        "torch": torch,
        "tokenizer": tokenizer,
        "model": model,
        "device": device,
        "business_id": business_id,
    }
    print(f"[relevance] classifier loaded from {MODEL_PATH} on {device}")
    return _loaded["handle"]


def p_business(texts: List[str]) -> List[float]:
    """P(business) for each text, straight from the classifier.

    Returns an empty list when the classifier isn't available, which callers
    read as "no opinion" — never as "not business".
    """
    handle = _load_classifier()
    if handle is None or not texts:
        return []

    torch = handle["torch"]
    tokenizer, model, device = handle["tokenizer"], handle["model"], handle["device"]
    business_id = handle["business_id"]

    scores: List[float] = []
    with torch.inference_mode():
        for i in range(0, len(texts), INFER_BATCH):
            batch = texts[i : i + INFER_BATCH]
            encoded = tokenizer(
                batch,
                truncation=True,
                max_length=MAX_LEN,
                padding=True,
                return_tensors="pt",
            ).to(device)
            probs = torch.softmax(model(**encoded).logits, dim=-1)
            scores.extend(probs[:, business_id].tolist())
    return scores


def classify_sentence(text: str) -> Tuple[str, float]:
    """Label one sentence. Returns (label, P(business)).

    Kept as a single-sentence entry point for scripts and tests; the pipeline
    itself goes through ``label_segments``, which batches.
    """
    text = (text or "").strip()
    if not text:
        return SMALL_TALK, 0.0
    if _has_business_signal(text):
        return BUSINESS, 1.0
    scores = p_business([text])
    if not scores:
        return BUSINESS, 1.0  # no classifier → keep, per rule 2
    p = scores[0]
    return (BUSINESS, p) if p >= KEEP_THRESHOLD else (SMALL_TALK, p)


# ---------------------------------------------------------------------------
# LLM judge — the fallback when there is no checkpoint, and the optional
# second opinion on sentences the classifier is unsure about. Unlike the
# classifier it sees the surrounding sentences and the speaker labels, which is
# what makes it worth asking about the hard cases specifically.
# ---------------------------------------------------------------------------

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


def _label_with_llm(
    index: List[Dict[str, Any]], *, on_progress: ProgressFn = None
) -> None:
    """Label every indexed sentence with the LLM, in batches."""
    batches = [index[i : i + BATCH] for i in range(0, len(index), BATCH)]
    for n, batch in enumerate(batches):
        verdicts = _classify_batch(batch)
        for item in batch:
            verdict = verdicts.get(item["id"])
            if verdict:
                _set_verdict(item["ref"], SMALL_TALK, verdict["reason"])
        if on_progress:
            on_progress((n + 1) / len(batches))


# ---------------------------------------------------------------------------
# Labelling
# ---------------------------------------------------------------------------


def _set_verdict(
    sentence: Dict[str, Any], label: str, reason: str = "", score: Optional[float] = None
) -> None:
    """Write a verdict onto a sentence dict from cleaning.annotate_segments."""
    sentence["label"] = label
    if score is not None:
        sentence["relevance"] = round(float(score), 3)
    # `reason` is what the transcript's tooltip shows, so only small talk
    # carries one — a kept sentence needs no explanation.
    if label == SMALL_TALK and reason:
        sentence["reason"] = reason
    else:
        sentence.pop("reason", None)


def _label_with_model(
    index: List[Dict[str, Any]], *, on_progress: ProgressFn = None
) -> None:
    """Label every indexed sentence with the fine-tuned classifier."""
    # Layer 1: the deterministic keep-override, before anything is scored.
    scoreable = []
    for item in index:
        if _has_business_signal(item["text"]):
            _set_verdict(item["ref"], BUSINESS, score=1.0)
        else:
            scoreable.append(item)

    # Layer 2: the classifier. An empty score list means it vanished mid-run,
    # in which case everything it didn't get to stays business.
    scores = p_business([item["text"] for item in scoreable])
    if on_progress:
        on_progress(0.9 if ESCALATE else 1.0)
    if not scores:
        print("[relevance] classifier unavailable mid-run; keeping everything")
        return

    unsure: List[Dict[str, Any]] = []
    for item, p in zip(scoreable, scores):
        if p >= KEEP_THRESHOLD:
            _set_verdict(item["ref"], BUSINESS, score=p)
        else:
            _set_verdict(
                item["ref"], SMALL_TALK, f"off-topic ({1 - p:.0%} confident)", score=p
            )
        # Layer 3 candidates: whichever way it went, the model was on the fence.
        if ESCALATE and max(p, 1.0 - p) < ESCALATE_BELOW:
            unsure.append(item)

    # Layer 3: a second opinion on the fence-sitters only. The LLM sees them in
    # spoken order with speakers attached, and silence from it means keep.
    if unsure:
        print(f"[relevance] escalating {len(unsure)} low-confidence sentences to {MODEL}")
        for item in unsure:
            _set_verdict(item["ref"], BUSINESS)
        _label_with_llm(
            unsure,
            on_progress=lambda frac: on_progress(0.9 + 0.1 * frac) if on_progress else None,
        )


def label_segments(
    segments: List[Dict[str, Any]], *, on_progress: ProgressFn = None
) -> List[Dict[str, Any]]:
    """Label every sentence, then build each turn's business-only text.

    Adds ``relevant`` to each segment (the cleaned business sentences joined)
    and sets ``label``/``reason`` on each entry in ``sentences``. Segments are
    mutated in place and returned.
    """
    # Only sentences with cleaned content are worth judging: one that cleaned
    # down to nothing was pure filler and is already accounted for.
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

    if not ENABLED:
        print("[relevance] disabled; keeping every sentence")
    elif index:
        chosen = backend()
        if chosen == "model":
            _label_with_model(index, on_progress=on_progress)
        elif chosen == "llm":
            if BACKEND == "auto":
                print(f"[relevance] {unavailable_reason()}; using {MODEL} instead")
            _label_with_llm(index, on_progress=on_progress)
        else:
            # RELEVANCE_BACKEND=model was pinned and the checkpoint won't load.
            # Keeping everything beats swapping in a different judge unasked.
            print(f"[relevance] {unavailable_reason()}; keeping every sentence")

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


# ---------------------------------------------------------------------------
# Introspection, for /health
# ---------------------------------------------------------------------------


def backend() -> str:
    """Which judge will actually run: "model", "llm", "off" or "none".

    "none" means the classifier was pinned but won't load, so the pass will
    keep everything. The first call loads the checkpoint (a second or two).
    """
    if not ENABLED:
        return "off"
    if BACKEND == "llm":
        return "llm"
    if _load_classifier() is not None:
        return "model"
    return "llm" if BACKEND == "auto" else "none"


def unavailable_reason() -> str:
    """Why the fine-tuned classifier isn't being used, or "" if it is."""
    return "" if _loaded["handle"] is not None else _loaded["error"]


def model_id() -> str:
    """Human-readable name of whatever is doing the judging."""
    chosen = backend()
    if chosen == "model":
        return str(MODEL_PATH)
    return MODEL if chosen == "llm" else chosen
