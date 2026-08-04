"""Build the small-talk vs. business dataset the relevance filter trains on.

    python build_dataset.py

Combines four free public corpora with locally-generated synthetic edge cases,
applies a *layered* labelling strategy, balances the two classes, de-duplicates
to prevent train/test leakage, and writes a train/validation/test split to disk
for ``finetune.py`` to consume.

    label 0 = smalltalk   (set aside — excluded from the notes and the SOP)
    label 1 = business    (kept — this is what an SOP gets written from)

**Why layered labelling.** A turn's *topic* is not its *meeting relevance*.
Topic tags alone mislabel the exact edge cases that matter:

  - "John is sick and will be out this week" — topic Health, but it is a
    staffing update, so: business.
  - "The regulation changes next month" — topic Politics, but usually
    irrelevant to an internal SOP, so: small talk.

So three signals are combined, cheapest first:

    1. topic prior          (work + finance = business, and NOT politics)
    2. deterministic staffing / project keyword overrides, which only ever flip
       a line *up* to business
    3. an optional, bounded Ollama relabel of the ambiguous slice

**Why the text is cleaned first.** At inference time ``relevance.py`` scores
``sentence["clean"]`` — one sentence, fillers already stripped by
``cleaning.py``. So every training example goes through the same
``cleaning.split_sentences`` + ``cleaning.clean_text`` treatment here. Training
on whole verbatim turns would mean serving a distribution the model never saw.

Everything runs locally and free. Ollama is only used for synthetic generation
and the optional relabel pass — set USE_OLLAMA = False (or leave Ollama down) to
build from the public corpora alone.

    pip install datasets
    # optional (synthetic + relabel): ollama pull llama3.1:8b
"""

from __future__ import annotations

import json
import math
import os
import random
import re
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, Iterator, List, Optional

from dotenv import load_dotenv

# Loaded before importing summarization, which reads OLLAMA_URL / OLLAMA_MODEL
# at import time — this script shares the server the rest of the backend uses.
load_dotenv(Path(__file__).resolve().with_name(".env"))

# Imported after load_dotenv, deliberately — see above.
import cleaning  # noqa: E402
import summarization  # noqa: E402

from datasets import Dataset, DatasetDict, concatenate_datasets, load_dataset

# ── Config ───────────────────────────────────────────────────────────────────
OUTPUT_DIR = Path(
    os.environ.get("RELEVANCE_DATASET_DIR")
    or Path(__file__).resolve().with_name("data") / "relevance-dataset"
)

USE_OLLAMA = os.environ.get("BUILD_USE_OLLAMA", "1") in ("1", "true", "True")
# Same Ollama server the backend already talks to; override just the model if
# you want a bigger one for data generation than for summarising.
OLLAMA_MODEL = os.environ.get("BUILD_OLLAMA_MODEL") or summarization.OLLAMA_MODEL
RELABEL_AMBIGUOUS = True   # LLM-relabel a bounded slice of ambiguous topics
RELABEL_CAP = 800          # max utterances sent to the LLM for relabelling
SYNTHETIC_PER_CLASS = 600
MEETING_MIN_WORDS = 6      # drop meeting backchannels ("yeah", "mm-hmm", "okay")
MIN_CHARS = 8
# How many candidate sentences to gather per sentence kept, so the capped
# sources are a random sample rather than the first N records. See _sample.
OVERSAMPLE = 3
SEED = 42

# DailyDialog topic ids (1-indexed, as annotated in the original corpus):
#   1 ordinary_life  2 school  3 culture  4 attitude  5 relationship
#   6 tourism        7 health  8 work     9 politics  10 finance
# Work + finance are a reliable business prior. Politics is deliberately NOT
# blanket-business: it is the single biggest false-positive source.
#
# CAVEAT, and it matters: the topic annotation only exists in the original
# release, whose host (yanran.li) is now a parked domain, and no Hub mirror
# carries the column — every mirror exposes dialog / act / emotion only. So the
# prior runs whenever a source *does* provide `topic` and degrades to
# UNKNOWN_TOPIC otherwise, where the layers underneath it take over: the
# keyword override still rescues work content, and the ambiguous slice the LLM
# relabels becomes the untagged slice. Nothing silently mislabels.
BUSINESS_TOPICS = {8, 10}
AMBIGUOUS_TOPICS = {3, 4, 7, 9}  # weakest prior → the slice worth relabelling
UNKNOWN_TOPIC = 0

# Dataset ids are tried in order, because Hub availability keeps shifting: some
# of these moved behind namespaced mirrors, the loading-script versions stopped
# working in datasets 3.x (handled by the parquet-branch retry in _try_load),
# and some went gated. A source that fails every candidate is skipped, not fatal.
DAILYDIALOG_IDS = ["li2017dailydialog/daily_dialog", "daily_dialog"]
EMPATHETIC_IDS = ["facebook/empathetic_dialogues", "empathetic_dialogues"]
# AMI is the meeting corpus we want, but knkarthick/AMI is gated (accept its
# terms on the Hub with HF_TOKEN set in .env and it loads first). MeetingBank —
# 1 300 hours of real city-council meetings — is the ungated stand-in: same
# multi-party meeting register, decisions, budgets and motions included.
AMI_IDS = ["knkarthick/AMI", "Qanastek/AMI-Corpus", "huuuyeah/meetingbank"]
QMSUM_IDS = ["pszemraj/qmsum-cleaned", "MocktaiLEngineer/qmsum-processed"]


# ── Labelling heuristics ─────────────────────────────────────────────────────
STAFFING_KEYWORDS = [
    "out today", "out this week", "on leave", "sick", "vacation", "pto",
    "absent", "off tomorrow", "covering for", "back on monday", "parental leave",
    "annual leave", "handover", "stand in for",
]
PROJECT_KEYWORDS = [
    "deadline", "client", "project", "deployment", "deploy", "release", "risk",
    "budget", "approval", "blocker", "blocked", "sprint", "staging", "ticket",
    "milestone", "requirement", "action item", "follow up", "follow-up", "kpi",
    "roadmap", "scope", "estimate", "invoice", "contract", "sla", "sign-off",
]
_OVERRIDE_RE = re.compile(
    "|".join(re.escape(k) for k in STAFFING_KEYWORDS + PROJECT_KEYWORDS),
    re.IGNORECASE,
)

# Obvious pleasantries. Used to *drop* lines from the meeting corpora (which we
# otherwise label wholesale as business) rather than to relabel them — a line
# this social is a label error waiting to happen, and there is no shortage of
# meeting-register data.
_SOCIAL_RE = re.compile(
    r"^(hi|hello|hey|good (morning|afternoon|evening)|thanks|thank you|"
    r"cheers|bye|goodbye|see you|welcome|how are you|nice to meet)\b"
    r"|\b(the weather|the weekend|your family|your holiday|last night's game)\b",
    re.IGNORECASE,
)

# AMI / QMSum transcripts carry annotation markup — strip it before cleaning.
_MARKUP_RE = re.compile(r"[<{]\s*[a-z_]+\s*[>}]", re.IGNORECASE)
# "Project Manager: right, so the remote…" — the speaker prefix is not content.
_SPEAKER_PREFIX_RE = re.compile(r"^\s*[A-Z][\w .'\-]{0,30}?\s*:\s+")


def rule_override(text: str, label: int) -> int:
    """Force business (1) when a line clearly carries staffing/project signal.

    This only ever flips *up* to business — it rescues real work content that a
    topic prior would have thrown away. It never downgrades.
    """
    return 1 if _OVERRIDE_RE.search(text) else label


def label_with_ollama(text: str) -> int:
    """LLM judge for meeting relevance. Returns 1, 0, or -1 (couldn't decide)."""
    system = (
        "You label a single utterance from a workplace meeting as BUSINESS or "
        "SMALL_TALK, for the purpose of meeting notes.\n\n"
        "BUSINESS = decisions, action items, blockers, project or product "
        "updates, staffing / availability, deadlines, client or budget "
        "discussion, risks, requirements.\n"
        "SMALL_TALK = greetings, jokes, weather, weekend / family chat, sports, "
        "casual personal conversation, filler.\n\n"
        "Reply with exactly one word: BUSINESS or SMALL_TALK."
    )
    try:
        reply = summarization._chat(system, f"Utterance: {text}", model=OLLAMA_MODEL)
    except summarization.SummaryUnavailable:
        return -1
    verdict = reply.strip().upper()
    if "SMALL" in verdict:
        return 0
    return 1 if "BUSINESS" in verdict else -1


OLLAMA_MODEL = os.environ.get("BUILD_OLLAMA_MODEL") or summarization.OLLAMA_MODEL


# ── Text normalisation (matches inference exactly) ───────────────────────────
def to_examples(text: str, label: int, *, min_words: int = 0) -> List[Dict[str, Any]]:
    """Split one turn into cleaned sentences, ready to train on.

    Same two calls the live pipeline makes, in the same order, so the model
    trains on the strings it will actually be asked about.
    """
    text = _MARKUP_RE.sub(" ", text or "").strip()
    text = _SPEAKER_PREFIX_RE.sub("", text)
    out: List[Dict[str, Any]] = []
    for piece in cleaning.split_sentences(text):
        sentence = cleaning.clean_text(piece).strip()
        if len(sentence) < MIN_CHARS:
            continue
        if min_words and len(sentence.split()) < min_words:
            continue
        out.append({"text": sentence, "label": label})
    return out


def _try_load(candidates: Iterable[str], name: str) -> Optional[Any]:
    """First Hub id that loads, or None. Availability shifts; failure is fine."""
    for repo_id in candidates:
        for kwargs in ({}, {"revision": "refs/convert/parquet"}):
            try:
                corpus = load_dataset(repo_id, **kwargs)
                print(f"  {name}: loaded {repo_id}")
                return corpus
            except Exception as exc:  # noqa: BLE001 - a missing source is not fatal
                # datasets 3+ refuses loading scripts ("Dataset scripts are no
                # longer supported"), but the Hub's conversion bot keeps a
                # parquet branch for exactly those repos — hence the retry.
                if not kwargs:
                    continue
                print(f"  {name}: {repo_id} unavailable ({type(exc).__name__})")
    print(f"  {name}: skipped")
    return None


# "Project Manager: right, so the remote…" — a turn attributed to a speaker.
_SPEAKER_LINE_RE = re.compile(r"^\s*[A-Za-z][\w .'\-]{0,30}?\s*:\s+\S")


def _sample(corpus: Any, target: int, produced: Callable[[], int]) -> Iterator[Dict[str, Any]]:
    """Yield records from a shuffled corpus until `target` examples exist.

    MeetingBank is 1 300 hours of speech and we keep 6 000 sentences of it, so
    reading the whole thing to throw away 99% of it is the difference between a
    build that takes a minute and one that takes an hour. Shuffling first means
    the early exit samples across the corpus instead of taking the first N
    meetings, which would skew towards whichever city or project comes first.
    """
    for split in corpus.keys():
        for example in corpus[split].shuffle(seed=SEED):
            yield example
            if produced() >= target:
                return


def _turns(example: Dict[str, Any]) -> List[str]:
    """Pull meeting turns out of a record whose schema we don't control.

    Mirrors differ: some store a list of {speaker, content} dicts, some a list
    of strings, some one newline-separated blob (QMSum prefixes that blob with
    the query the summary answers; MeetingBank has no speaker labels at all).
    Try all of them, and where the blob *is* speaker-labelled keep only the
    labelled lines, which drops the query and any stray heading.
    """
    for field in (
        "meeting_transcript", "transcript", "dialogue", "dialog", "input", "text",
    ):
        value = example.get(field)
        if isinstance(value, list):
            turns = []
            for turn in value:
                if isinstance(turn, dict):
                    turns.append(str(turn.get("content") or turn.get("text") or ""))
                elif isinstance(turn, str):
                    turns.append(turn)
            if turns:
                return turns
        if isinstance(value, str) and value.strip():
            lines = [line for line in value.splitlines() if line.strip()]
            labelled = [line for line in lines if _SPEAKER_LINE_RE.match(line)]
            return labelled or lines
    return []


# ── Source loaders ───────────────────────────────────────────────────────────
def load_dailydialog(relabel: bool) -> Dataset:
    """Chat-register data, labelled by topic prior + overrides (+ optional LLM)."""
    dd = _try_load(DAILYDIALOG_IDS, "DailyDialog")
    if dd is None:
        return Dataset.from_list([])

    records: List[Dict[str, Any]] = []
    tagged = 0
    for split in dd.keys():
        for ex in dd[split]:
            topic = int(ex.get("topic") or UNKNOWN_TOPIC)
            tagged += topic != UNKNOWN_TOPIC
            # One mirror stores whole dialogs, another one utterance per row.
            utterances = ex.get("dialog") or ex.get("utterance") or []
            if isinstance(utterances, str):
                utterances = [utterances]
            for utt in utterances:
                prior = 1 if topic in BUSINESS_TOPICS else 0
                for row in to_examples(str(utt), prior):
                    row["label"] = rule_override(row["text"], row["label"])
                    row["topic"] = topic
                    records.append(row)
    if not tagged:
        print("  (no topic annotation in this mirror — prior is smalltalk + overrides)")

    if relabel and USE_OLLAMA:
        # Relabel only the ambiguous, prior=smalltalk slice — the
        # highest-value direction, business hiding inside health / politics /
        # culture chat, or inside a mirror with no topics at all. Bounded by
        # RELABEL_CAP so the build stays quick.
        ambiguous = AMBIGUOUS_TOPICS | {UNKNOWN_TOPIC}
        pool = [r for r in records
                if r["topic"] in ambiguous and r["label"] == 0]
        random.Random(SEED).shuffle(pool)
        pool = pool[:RELABEL_CAP]
        print(f"  relabelling {len(pool)} ambiguous utterances via {OLLAMA_MODEL}…")
        flipped = 0
        for n, r in enumerate(pool):     # r is a reference into `records`
            verdict = label_with_ollama(r["text"])
            if verdict == -1:
                # The server is down or wedged: stop rather than crawl through
                # 800 timeouts. The topic prior still stands for the rest.
                print("  relabel pass aborted (Ollama unreachable)")
                break
            if verdict != r["label"]:
                r["label"] = verdict
                flipped += 1
            if n and n % 100 == 0:
                print(f"    {n}/{len(pool)} ({flipped} flipped)")
        print(f"  relabel flipped {flipped} labels")

    ds = Dataset.from_list([{"text": r["text"], "label": r["label"]} for r in records])
    print(f"DailyDialog: {len(ds)} sentences")
    return ds


def load_empathetic(cap: int = 5000) -> Dataset:
    """Personal / emotional conversation — near-pure small talk for our purpose."""
    emp = _try_load(EMPATHETIC_IDS, "EmpatheticDialogues")
    if emp is None:
        return Dataset.from_list([])

    recs: List[Dict[str, Any]] = []
    for ex in _sample(emp, cap * OVERSAMPLE, lambda: len(recs)):
        # This corpus stores commas as the literal token "_comma_".
        text = str(ex.get("utterance") or "").replace("_comma_", ",")
        for row in to_examples(text, 0):
            row["label"] = rule_override(row["text"], row["label"])
            recs.append(row)
    random.Random(SEED).shuffle(recs)
    ds = Dataset.from_list(recs[:cap])
    print(f"EmpatheticDialogues: {len(ds)} sentences")
    return ds


def _meeting_corpus(ids: List[str], name: str, cap: int) -> Dataset:
    """Real meeting turns, labelled business — with the worst noise filtered out.

    Real meetings contain small talk too, so labelling every turn business
    injects label noise. Two cheap filters take out most of it: a length floor
    (backchannels and one-word greetings) and an obvious-pleasantry regex.
    Residual noise is the accepted trade-off for free meeting-register signal;
    DailyDialog and the synthetic pass carry the clean labels.
    """
    corpus = _try_load(ids, name)
    if corpus is None:
        return Dataset.from_list([])

    recs: List[Dict[str, Any]] = []
    for ex in _sample(corpus, cap * OVERSAMPLE, lambda: len(recs)):
        for turn in _turns(ex):
            for row in to_examples(turn, 1, min_words=MEETING_MIN_WORDS):
                if _SOCIAL_RE.search(row["text"]):
                    continue
                recs.append(row)
    random.Random(SEED).shuffle(recs)
    ds = Dataset.from_list(recs[:cap])
    print(f"{name}: {len(ds)} sentences")
    return ds


def load_ami(cap: int = 6000) -> Dataset:
    return _meeting_corpus(AMI_IDS, "AMI", cap)


def load_qmsum(cap: int = 4000) -> Dataset:
    return _meeting_corpus(QMSUM_IDS, "QMSum", cap)


# ── Synthetic edge cases (the most task-aligned data we have) ────────────────
_SMALL_TALK_PROMPT = (
    "Generate {n} realistic small-talk utterances from office / business "
    "meetings. These are social, personal, or irrelevant sentences — NOT work "
    "discussions. Include the ones that SOUND like instructions but are about "
    "the room or the call, not the work: \"Could you switch off the AC?\", "
    "\"You're on mute\", \"Let me share my screen\", \"Is it cold in here?\". "
    "Also include ordinary chatter: \"Did you catch the game last night?\", "
    "\"How's your family doing?\", \"Traffic was terrible this morning\".\n"
    "Return ONLY the utterances, one per line, no numbering, no quotes."
)
_BUSINESS_PROMPT = (
    "Generate {n} realistic business-relevant utterances from office meetings. "
    "These are work-focused sentences that belong in meeting notes. Include "
    "edge cases that SOUND personal but ARE work-related: "
    "\"John is out sick this week so his tasks are blocked\", "
    "\"I'll follow up with the client tomorrow\", "
    "\"We need to push the deadline by two weeks\", "
    "\"Have you finished the risk assessment?\", "
    "\"Sarah is covering the handover while Mike is on leave\".\n"
    "Return ONLY the utterances, one per line, no numbering, no quotes."
)


def _gen_batch(prompt: str, label: int, n_total: int, batch: int = 50) -> List[Dict[str, Any]]:
    """Generate in small batches (more reliable) and dedupe within the class."""
    recs: List[Dict[str, Any]] = []
    seen: set = set()
    for _ in range(max(1, math.ceil(n_total / batch))):
        try:
            reply = summarization._chat(
                "You generate training data. Follow the format exactly.",
                prompt.format(n=batch),
                model=OLLAMA_MODEL,
            )
        except summarization.SummaryUnavailable as exc:
            print(f"    synthetic batch failed: {exc}")
            break
        for line in reply.splitlines():
            text = line.strip(" -•\t\"'0123456789.").strip()
            if len(text) < MIN_CHARS or text.lower() in seen:
                continue
            seen.add(text.lower())
            recs.extend(to_examples(text, label))
        if len(recs) >= n_total:
            break
    return recs[:n_total]


def generate_synthetic(n_each: int = SYNTHETIC_PER_CLASS) -> Dataset:
    if not USE_OLLAMA:
        return Dataset.from_list([])
    print(f"Generating synthetic edge cases with {OLLAMA_MODEL}…")
    recs = _gen_batch(_SMALL_TALK_PROMPT, 0, n_each)
    recs += _gen_batch(_BUSINESS_PROMPT, 1, n_each)
    ds = Dataset.from_list(recs)
    print(f"Synthetic: {len(ds)} sentences")
    return ds


# ── Assembly ─────────────────────────────────────────────────────────────────
def dedupe(ds: Dataset) -> Dataset:
    """Drop duplicate texts so the same line can't land in two splits.

    Leakage here would show up as an inflated test score and nothing else, so
    it is worth the pass even though it is O(n).
    """
    seen: set = set()
    keep: List[int] = []
    for i, ex in enumerate(ds):
        key = re.sub(r"\W+", " ", ex["text"].lower()).strip()
        if key in seen:
            continue
        seen.add(key)
        keep.append(i)
    return ds.select(keep)


def balance(ds: Dataset, seed: int = SEED) -> Dataset:
    """Downsample the majority class to 1:1."""
    pos = ds.filter(lambda x: x["label"] == 1)
    neg = ds.filter(lambda x: x["label"] == 0)
    n = min(len(pos), len(neg))
    if not n:
        raise SystemExit("One class came out empty — check which sources loaded.")
    pos = pos.shuffle(seed=seed).select(range(n))
    neg = neg.shuffle(seed=seed).select(range(n))
    return concatenate_datasets([pos, neg]).shuffle(seed=seed)


def main() -> None:
    print("Building the EchoNotes relevance dataset…\n")
    if not USE_OLLAMA:
        print("(Ollama disabled — no synthetic data, no relabel pass)\n")

    sources = [
        load_dailydialog(relabel=RELABEL_AMBIGUOUS),
        load_empathetic(),
        load_ami(),
        load_qmsum(),
        generate_synthetic(),
    ]
    sources = [s for s in sources if len(s) > 0]
    if not sources:
        raise SystemExit("No sources loaded — check dataset availability / network.")

    combined = concatenate_datasets([s.select_columns(["text", "label"]) for s in sources])
    print(f"\nCombined (raw): {len(combined)}")

    combined = dedupe(combined)
    print(f"After dedupe:   {len(combined)}")

    combined = balance(combined)
    n_pos = sum(1 for x in combined if x["label"] == 1)
    print(f"After balance:  {len(combined)} "
          f"(business={n_pos}, smalltalk={len(combined) - n_pos})")

    # 80 / 10 / 10, saved as a DatasetDict so finetune.py loads it directly.
    split = combined.train_test_split(test_size=0.2, seed=SEED)
    val_test = split["test"].train_test_split(test_size=0.5, seed=SEED)
    ds = DatasetDict({
        "train": split["train"],
        "validation": val_test["train"],
        "test": val_test["test"],
    })

    OUTPUT_DIR.parent.mkdir(parents=True, exist_ok=True)
    ds.save_to_disk(str(OUTPUT_DIR))
    # A tiny manifest next to the data: which knobs produced this build, so a
    # surprising model can be traced back to the dataset that made it.
    (OUTPUT_DIR / "build.json").write_text(json.dumps({
        "sources": len(sources),
        "used_ollama": USE_OLLAMA,
        "ollama_model": OLLAMA_MODEL if USE_OLLAMA else None,
        "relabel_cap": RELABEL_CAP if RELABEL_AMBIGUOUS and USE_OLLAMA else 0,
        "synthetic_per_class": SYNTHETIC_PER_CLASS if USE_OLLAMA else 0,
        "meeting_min_words": MEETING_MIN_WORDS,
        "seed": SEED,
        "splits": {k: len(v) for k, v in ds.items()},
    }, indent=2))

    print(f"\nSaved to {OUTPUT_DIR}")
    print({k: len(v) for k, v in ds.items()})
    print("\nNext: python finetune.py")


if __name__ == "__main__":
    main()
