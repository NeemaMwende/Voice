"""WeSpeaker re-clustering: fold pyannote's phantom speakers back together.

    pyannote turns → whole-turn WeSpeaker embeddings → cosine clustering → merged turns

pyannote decides who is speaking from embeddings of short sliding windows. That
is the right unit for *finding* speaker changes and the wrong one for *counting*
speakers: a few seconds of audio makes a noisy embedding, and noisy embeddings
split one person across several clusters. The result is the familiar failure —
a two-person meeting that comes back with five speakers, the same voice
scattered across "Speaker 2", "Speaker 4" and "Speaker 5".

This pass fixes that after the fact, using something pyannote's clustering stage
never had: each speaker's *entire* contribution to the conversation, pooled into
one embedding.

Why there are two thresholds
----------------------------
The obvious design — one cosine threshold, merge anything above it — does not
survive contact with real recordings. Measured on EchoNotes audio, how much
speech backs an embedding decides everything:

    pooled audio   same speaker (min)   different speakers (median)
      0 - 3 s          0.069                    0.152
      3 - 6 s          0.079                    0.191
      6 - 12 s         0.678                    0.451
      12 s +           0.932                    0.193

Past roughly six seconds the two populations stop overlapping — the worst
same-speaker pair measured there (0.678, one voice cut into 6.8 s pieces) sits
well above the worst pair of genuinely different speakers (0.373). Below six
seconds they interleave completely: one speaker's own two halves can land at
0.069, *below* the median for two different people. A single threshold tuned
for the clean region refuses to merge anything short; one tuned for the short
region fuses real speakers.

So the pass splits on evidence rather than pretending it is uniform:

  * Speakers with enough pooled speech are clustered against each other at a
    strict threshold, in the region where the answer is unambiguous.
  * Speakers with too little are never allowed to drag a real speaker around.
    They may only be *absorbed into* an established cluster, and only when the
    best match beats the runner-up by a clear margin — relative evidence, which
    survives a noisy centroid far better than an absolute score does.

Nothing here needs to be told how many speakers to expect. The count stays
fully automatic; the only judgement is "are these two the same voice", which is
a question about a fixed embedding space rather than about this recording, so
calibrated thresholds generalise across meetings in a way a hardcoded
``num_speakers`` never could.

The embedding model is WeSpeakerResNet34 — the same one already loaded inside
the diarization pipeline, borrowed rather than loaded a second time, so this
costs no extra download and no extra memory, and the embeddings are guaranteed
to live in the same space the pipeline itself clustered in.

Config (env / .env):
  * SPEAKER_MERGE            — "0" disables the pass (default on)
  * SPEAKER_MERGE_THRESHOLD  — cosine similarity to merge confident speakers (default 0.70)
  * SPEAKER_MERGE_CONFIDENT  — pooled speech needed to be "confident", seconds (default 6.0)
  * SPEAKER_MERGE_WEAK_MIN   — floor for absorbing a low-evidence speaker (default 0.35)
  * SPEAKER_MERGE_WEAK_MARGIN— how far the best match must beat the runner-up (default 0.10)
  * SPEAKER_MERGE_MIN_TURN   — shortest turn worth embedding, seconds (default 0.5)
  * SPEAKER_MERGE_MAX_TURNS  — turns embedded per speaker, longest first (default 40)
"""

from __future__ import annotations

import os
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

ENABLED = os.environ.get("SPEAKER_MERGE", "1") in ("1", "true", "True")

# Chosen from the measured gap. On this audio the worst same-speaker pair with
# enough evidence behind it scored 0.678 (one voice cut into 6.8 s pieces), and
# the worst pair of genuinely different speakers scored 0.373. 0.65 clears the
# false-merge side by a wide margin while still catching the hardest true merge.
THRESHOLD = float(os.environ.get("SPEAKER_MERGE_THRESHOLD", "0.65"))

# Pooled speech at which a centroid becomes trustworthy. Below this the
# same/different distributions overlap and no threshold can separate them.
CONFIDENT_SEC = float(os.environ.get("SPEAKER_MERGE_CONFIDENT", "6.0"))

# For a speaker too small to be confident, an absolute score means little, so
# it is only a floor — the margin below does the real work.
WEAK_MIN = float(os.environ.get("SPEAKER_MERGE_WEAK_MIN", "0.35"))
WEAK_MARGIN = float(os.environ.get("SPEAKER_MERGE_WEAK_MARGIN", "0.10"))

# Under half a second an embedding describes the room more than the voice.
MIN_TURN_SEC = float(os.environ.get("SPEAKER_MERGE_MIN_TURN", "0.5"))

# Embedding cost scales with turns, and a centroid stops moving long before a
# speaker's 40th turn. Longest-first, so the cap keeps the best evidence.
MAX_TURNS = int(os.environ.get("SPEAKER_MERGE_MAX_TURNS", "40"))


class Merge:
    """What the pass did, for logging."""

    def __init__(self, mapping: Dict[str, str], before: int, after: int):
        self.mapping = mapping
        self.before = before
        self.after = after

    @property
    def changed(self) -> bool:
        return self.after < self.before

    def describe(self) -> str:
        if not self.changed:
            return f"{self.before} speaker(s), nothing to merge"
        groups: Dict[str, List[str]] = {}
        for src, dst in sorted(self.mapping.items()):
            if src != dst:
                groups.setdefault(dst, []).append(src)
        detail = "; ".join(f"{'+'.join(v)} -> {k}" for k, v in sorted(groups.items()))
        return f"{self.before} -> {self.after} speakers ({detail})"


def _embed(embedding, waveform: np.ndarray, start: float, end: float, sample_rate: int):
    """L2-normalised embedding for one turn, or None if it's too short to trust."""
    import torch

    a, b = int(start * sample_rate), int(end * sample_rate)
    chunk = waveform[max(0, a):min(len(waveform), b)]
    if len(chunk) < MIN_TURN_SEC * sample_rate:
        return None

    # The model wants (batch, channel, samples). It scales and centres the
    # samples itself, so the [-1, 1] floats we decode to go straight in.
    tensor = torch.from_numpy(np.ascontiguousarray(chunk, dtype=np.float32)).reshape(1, 1, -1)
    with torch.no_grad():
        vector = np.asarray(embedding(tensor)).reshape(-1)

    norm = float(np.linalg.norm(vector))
    # A degenerate crop (digital silence, all-NaN) comes back as a zero or
    # non-finite vector; normalising that would poison the centroid.
    if not np.isfinite(norm) or norm <= 0.0:
        return None
    return vector / norm


def _pool(vectors: Sequence[np.ndarray], weights: Sequence[float]) -> Optional[np.ndarray]:
    pooled = np.average(np.stack(vectors), axis=0, weights=np.array(weights))
    norm = float(np.linalg.norm(pooled))
    return pooled / norm if np.isfinite(norm) and norm > 0 else None


def _profile(
    turns: Sequence[dict], waveform: np.ndarray, sample_rate: int, embedding
) -> Tuple[Dict[str, np.ndarray], Dict[str, float]]:
    """Per speaker: a pooled embedding, and the seconds of speech behind it.

    The duration returned is the *embedded* audio, not the speaker's total —
    turns too short to embed contribute nothing to the centroid, so counting
    them would overstate how much evidence it rests on, which is exactly the
    judgement the confident/weak split depends on.
    """
    by_speaker: Dict[str, List[Tuple[float, float]]] = {}
    for turn in turns:
        by_speaker.setdefault(str(turn["speaker"]), []).append(
            (float(turn["start"]), float(turn["end"]))
        )

    centroids: Dict[str, np.ndarray] = {}
    pooled_sec: Dict[str, float] = {}
    for speaker, spans in by_speaker.items():
        # Longest first, so the cap keeps the most informative turns.
        ranked = sorted(spans, key=lambda span: span[1] - span[0], reverse=True)[:MAX_TURNS]
        vectors, weights = [], []
        for start, end in ranked:
            vector = _embed(embedding, waveform, start, end, sample_rate)
            if vector is not None:
                vectors.append(vector)
                weights.append(end - start)
        if not vectors:
            continue
        pooled = _pool(vectors, weights)
        if pooled is not None:
            centroids[speaker] = pooled
            pooled_sec[speaker] = float(sum(weights))

    return centroids, pooled_sec


def _cluster(speakers: List[str], centroids: Dict[str, np.ndarray]) -> List[List[str]]:
    """Group speakers by voice at the strict threshold. Returns member lists.

    Everyone is clustered here, well-evidenced or not. The strict threshold is
    safe to apply even to a noisy centroid: it sits above every pair of
    genuinely different speakers seen in calibration (worst 0.373, and 0.619
    even counting pairs where pyannote's own labelling was suspect). A weak
    speaker simply tends not to reach it, which costs a merge we might have
    wanted but never causes one we didn't.
    """
    if len(speakers) == 1:
        return [list(speakers)]

    from sklearn.cluster import AgglomerativeClustering

    matrix = np.stack([centroids[s] for s in speakers])
    similarity = np.clip(matrix @ matrix.T, -1.0, 1.0)
    distance = 1.0 - similarity
    np.fill_diagonal(distance, 0.0)

    # Complete linkage: every pair in a group must clear the bar before they
    # merge. Average linkage would let A and C join through a middling B even
    # when A and C are plainly different people — the chaining failure that
    # makes a merge pass worse than the problem it fixes.
    labels = AgglomerativeClustering(
        n_clusters=None,
        distance_threshold=1.0 - THRESHOLD,
        metric="precomputed",
        linkage="complete",
    ).fit_predict(distance)

    groups: Dict[int, List[str]] = {}
    for speaker, label in zip(speakers, labels):
        groups.setdefault(int(label), []).append(speaker)
    return list(groups.values())


def _absorb_lonely(
    lonely: List[List[str]],
    anchors: List[List[str]],
    centroids: Dict[str, np.ndarray],
    pooled_sec: Dict[str, float],
    mapping: Dict[str, str],
) -> None:
    """Fold leftover low-evidence groups into an established one, where clear-cut.

    These are the groups the strict pass left alone and that still don't have
    enough speech behind them to be believed — the sub-second phantoms. Their
    centroids are too noisy for an absolute score to mean much, so the decision
    rests mainly on *relative* evidence: the best anchor must beat the runner-up
    by a clear margin. A weak group is only ever absorbed into a well-evidenced
    one, never the reverse, so a phantom can never drag a real speaker's label
    with it. Ambiguous cases keep their own label — a stray extra speaker is a
    much smaller sin than words attributed to the wrong person.
    """
    if not anchors or not lonely:
        return

    anchor_vectors = []
    for group in anchors:
        pooled = _pool([centroids[s] for s in group], [pooled_sec[s] for s in group])
        if pooled is not None:
            anchor_vectors.append((mapping[group[0]], pooled))
    if not anchor_vectors:
        return

    for group in lonely:
        pooled = _pool([centroids[s] for s in group], [pooled_sec[s] for s in group])
        if pooled is None:
            continue
        scores = sorted(
            ((float(pooled @ vector), label) for label, vector in anchor_vectors),
            reverse=True,
        )
        best_score, best_label = scores[0]
        runner_up = scores[1][0] if len(scores) > 1 else -1.0
        if best_score >= WEAK_MIN and (best_score - runner_up) >= WEAK_MARGIN:
            for member in group:
                mapping[member] = best_label


def merge_turns(
    turns: List[Dict[str, object]],
    waveform: Optional[np.ndarray],
    sample_rate: int,
    embedding,
) -> Tuple[List[Dict[str, object]], Optional[Merge]]:
    """Relabel ``turns`` so one voice carries one label.

    Returns ``(turns, Merge)``. The turns come back untouched — and Merge is
    None — whenever the pass is off, the inputs are unusable, or anything goes
    wrong: over-segmented speakers are a quality problem, and failing a whole
    transcription over one would be a far worse outcome.
    """
    if not ENABLED or waveform is None or embedding is None or len(turns) < 2:
        return turns, None
    if waveform.size == 0:
        return turns, None

    try:
        before = len({str(t["speaker"]) for t in turns})
        centroids, pooled_sec = _profile(turns, waveform, sample_rate, embedding)
        if len(centroids) < 2:
            return turns, None

        # Speakers we couldn't embed at all aren't candidates either way, so
        # they start out mapped to themselves and are never touched below.
        mapping: Dict[str, str] = {str(t["speaker"]): str(t["speaker"]) for t in turns}

        ranked = sorted(centroids, key=lambda s: pooled_sec[s], reverse=True)
        groups = _cluster(ranked, centroids)

        for group in groups:
            # The talkative member names the group: it carries the most
            # evidence and keeps the dominant speaker's label stable for the
            # downstream name detection.
            winner = max(group, key=lambda s: pooled_sec[s])
            for member in group:
                mapping[member] = winner

        # A group's evidence is its members' combined speech, so several small
        # fragments that the strict pass already joined can together clear the
        # bar and act as an anchor in their own right.
        anchors, lonely = [], []
        for group in groups:
            total = sum(pooled_sec[s] for s in group)
            (anchors if total >= CONFIDENT_SEC else lonely).append(group)
        _absorb_lonely(lonely, anchors, centroids, pooled_sec, mapping)

        merged = [dict(turn, speaker=mapping[str(turn["speaker"])]) for turn in turns]
        after = len({str(t["speaker"]) for t in merged})
        return merged, Merge(mapping, before, after)
    except Exception as exc:  # noqa: BLE001 - never fail a transcription over a merge
        print(f"[speakers] WeSpeaker merge failed, keeping pyannote's labels: {exc}")
        return turns, None
