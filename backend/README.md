# EchoNotes Backend

Accepts an audio upload and returns a transcript split into **speaker-labeled
segments**. Transcription is done by [faster-whisper]; speaker diarization by
[pyannote/speaker-diarization-3.1]. The two are combined in `main.py`
(`diarization.py` holds the pyannote pipeline).

Before either of them runs, the audio is cleaned up in two passes, and after
pyannote runs, its speaker labels get a second opinion:

```
upload → DeepFilterNet (denoise.py) → Silero VAD (vad.py) → Whisper + pyannote
             remove noise                remove silence           ↓
                                          speaker_merge.py ← WeSpeaker re-clustering
                                            fold duplicate speakers together
```

[DeepFilterNet] suppresses background noise — fans, traffic, keyboards, mic
hiss — and [Silero VAD] then cuts the silence out so the two expensive stages
only ever see speech. Neither pass is allowed to be fatal: if a model is
missing or fails, the pipeline falls back to the original audio and the
transcription still completes. Both preserve the original timeline, so every
timestamp still points at the right moment of the file the user plays back.

[faster-whisper]: https://github.com/SYSTRAN/faster-whisper
[pyannote/speaker-diarization-3.1]: https://huggingface.co/pyannote/speaker-diarization-3.1
[DeepFilterNet]: https://github.com/Rikorose/DeepFilterNet
[Silero VAD]: https://github.com/snakers4/silero-vad
[WeSpeaker]: https://github.com/wenet-e2e/wespeaker

## Why a second speaker pass (`speaker_merge.py`)

pyannote decides who is speaking from embeddings of short sliding windows. That
is the right unit for *finding* speaker changes and the wrong one for *counting*
speakers: a few seconds of audio makes a noisy embedding, and noisy embeddings
split one person across several clusters — the familiar "two-person meeting
comes back with five speakers".

`speaker_merge.py` re-checks that using each speaker's *entire* contribution
pooled into one [WeSpeaker] embedding, which is far more stable, and folds
together labels that turn out to be the same voice. It needs no `num_speakers`
hint — the count stays fully automatic.

The embedding model is `WeSpeakerResNet34`, **already loaded inside the
diarization pipeline** (community-1 ships it as its embedding stage), so this
borrows it rather than loading a second copy: no extra download, no extra
memory, and the vectors are guaranteed to live in the same space pyannote
clustered in.

### How the thresholds were chosen

Measured on real EchoNotes recordings — how much pooled speech backs an
embedding decides everything:

| pooled audio | same speaker (min) | different speakers (median) |
| ------------ | ------------------ | --------------------------- |
| 0 – 3 s      | 0.069              | 0.152                       |
| 3 – 6 s      | 0.079              | 0.191                       |
| 6 – 12 s     | 0.678              | 0.451                       |
| 12 s +       | 0.932              | 0.193                       |

Past ~6 s the populations separate cleanly; below it they interleave, and one
speaker's own two halves can score *below* the median for two different people.
So a single threshold can't work, and the pass splits on evidence instead:
well-evidenced speakers are clustered at a strict cosine threshold (0.65, in
the measured gap between the worst true merge at 0.678 and the worst false one
at 0.373), while low-evidence fragments may only be *absorbed into* an
established cluster, and only when the best match clearly beats the runner-up.

Verified against ground truth built from audio rather than from pyannote's own
labels (a single continuous turn is one person by construction): 18/18 checks —
one voice cut into 2/3/4 pieces always rejoins, two real speakers never fuse,
6 pseudo-speakers from 2 real people come back as exactly 2, and sub-second
phantoms are absorbed.

> Note: the `clustering: {method, min_cluster_size, threshold}` recipe that
> circulates for pyannote 3.1 does **not** apply to community-1 — it uses VBx
> clustering, whose parameters are `threshold`, `Fa` and `Fb`. Passing the AHC
> names raises an error.

## Setup

```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: .\venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r requirements.txt
./scripts/install_deep_filter.sh  # DeepFilterNet binary → backend/bin/
```

`ffmpeg` and `ffprobe` must be on PATH (they already are for diarization).

### Why DeepFilterNet isn't a pip dependency

`pip install deepfilternet` can't go in `requirements.txt`: it pins `numpy<2`
(torch and faster-whisper are on 2.x here), its native half has no wheel for
Python 3.12 and needs a Rust toolchain, and it imports a `torchaudio` API that
2.x removed. Installing it would break the rest of the environment. The
upstream project ships a self-contained `deep-filter` binary from the same
release with the DeepFilterNet3 weights baked in, so `install_deep_filter.sh`
fetches that instead and `denoise.py` shells out to it — the same approach
`diarization.py` already takes with ffmpeg.

Skipping the script is safe: `GET /health` will report `denoise_available:
false` with a `denoise_note` explaining why, and transcription runs on the
un-denoised audio.

### Enable speaker diarization (pyannote)

pyannote 3.1 is gated on Hugging Face, so a one-time authorization is required:

1. Log in to Hugging Face and **accept the model terms** at
   <https://huggingface.co/pyannote/speaker-diarization-3.1>
   (also accept <https://huggingface.co/pyannote/segmentation-3.0>).
2. Create an access token at <https://huggingface.co/settings/tokens>.
3. Export it before starting the server:

   ```bash
   export HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxx
   ```

If `HF_TOKEN` is missing or the terms aren't accepted, the server still
transcribes but falls back to gap-based `Speaker N` labeling instead of real
diarization. Check `GET /health` — `diarization_available` and
`diarization_note` tell you what's going on.

## Run

```bash
python3 main.py
# or, with autoreload during development:
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

The server listens on `http://127.0.0.1:8000`. The frontend points at this via
`NEXT_PUBLIC_API_URL` (default `http://127.0.0.1:8000`).

## Endpoints

- `GET /health` — model + diarization status, plus which relevance backend is
  live (`relevance_backend`, `relevance_model`, `relevance_note`).
- `POST /transcribe` (multipart `file`) — returns:

  ```json
  {
    "transcript": "full text …",
    "segments": [
      { "speaker": "Speaker 1", "start": 0.0, "end": 3.2, "text": "…" }
    ],
    "language": "en",
    "duration": 32.0
  }
  ```

## Configuration (env vars)

| Var                 | Default                              | Purpose                              |
| ------------------- | ------------------------------------ | ------------------------------------ |
| `MODEL_NAME`        | `small`                              | Whisper size (`tiny`…`large-v3`)     |
| `WHISPER_DEVICE`    | `cpu`                                | `cpu` or `cuda`                      |
| `WHISPER_COMPUTE`   | `int8`                               | compute type (e.g. `float16` on GPU) |
| `WHISPER_LANGUAGE`  | _(auto-detect)_                      | force a language, e.g. `en`          |
| `DIARIZATION_MODEL` | `pyannote/speaker-diarization-3.1`   | diarization pipeline id              |
| `HF_TOKEN`          | —                                    | Hugging Face token (for pyannote)    |
| `HOST` / `PORT`     | `0.0.0.0` / `8000`                   | server bind address                  |

### Noise suppression (`denoise.py`)

| Var                     | Default            | Purpose                                        |
| ----------------------- | ------------------ | ---------------------------------------------- |
| `DEEPFILTER`            | `1`                | `0` skips denoising entirely                   |
| `DEEPFILTER_BIN`        | `backend/bin/deep-filter` | path to the binary                      |
| `DEEPFILTER_ATTEN_DB`   | `100`              | attenuation limit in dB; lower = gentler        |
| `DEEPFILTER_POSTFILTER` | `0`                | `1` sharpens speech, adds some artefacts        |
| `DEEPFILTER_CHUNK_SEC`  | `300`              | seconds of audio per parallel chunk             |
| `DEEPFILTER_WORKERS`    | cores/4, max 4     | chunks denoised in parallel                     |

### Speaker re-clustering (`speaker_merge.py`)

| Var                          | Default | Purpose                                             |
| ---------------------------- | ------- | --------------------------------------------------- |
| `SPEAKER_MERGE`              | `1`     | `0` keeps pyannote's labels untouched               |
| `SPEAKER_MERGE_THRESHOLD`    | `0.65`  | cosine similarity to merge well-evidenced speakers  |
| `SPEAKER_MERGE_CONFIDENT`    | `6.0`   | pooled speech (s) before a centroid is believed     |
| `SPEAKER_MERGE_WEAK_MIN`     | `0.35`  | floor for absorbing a low-evidence fragment         |
| `SPEAKER_MERGE_WEAK_MARGIN`  | `0.10`  | how far the best match must beat the runner-up      |
| `SPEAKER_MERGE_MIN_TURN`     | `0.5`   | shortest turn worth embedding (s)                   |
| `SPEAKER_MERGE_MAX_TURNS`    | `40`    | turns embedded per speaker, longest first           |

Raise `SPEAKER_MERGE_THRESHOLD` if distinct speakers ever get fused; lower it
if one person still comes back as several. Passing `num_speakers` to
`/transcribe` skips this pass entirely — you've already given the exact answer.

### Silence trimming (`vad.py`)

| Var                  | Default | Purpose                                        |
| -------------------- | ------- | ---------------------------------------------- |
| `SILERO_VAD`         | `1`     | `0` skips the VAD pre-pass entirely            |
| `SILERO_VAD_ONNX`    | `1`     | `0` uses the PyTorch weights instead of ONNX   |
| `VAD_THRESHOLD`      | `0.3`   | speech probability cutoff, 0–1                 |
| `VAD_MIN_SILENCE_MS` | `1000`  | silence this long ends a speech chunk          |
| `VAD_SPEECH_PAD_MS`  | `400`   | padding kept either side of speech             |
| `VAD_MIN_SPEECH_MS`  | `0`     | drop speech chunks shorter than this           |

## The text pipeline: cleaning → relevance → rewrite

Once there is a speaker-labelled transcript, three passes turn it into something
an SOP can be written from. Nothing is ever deleted — each pass adds a field, so
every earlier tier is still there to show in the UI:

```
turns → cleaning.py ──→ relevance.py ─────→ rewrite.py ──→ summarization.py
        strip fillers   label each          repair the      notes + the
        & split into    sentence business   wording of      business record
        sentences       or smalltalk        what's left
          ↓                  ↓                  ↓
        seg.clean         seg.relevant      seg.polished
```

| Field           | What it holds                                                    |
| --------------- | ---------------------------------------------------------------- |
| `text`          | verbatim, exactly as spoken                                      |
| `clean`         | fillers, stutters and noise tags removed; every topic still there |
| `relevant`      | the cleaned **business** sentences only — what the UI renders     |
| `polished`      | `relevant` with its wording repaired — what the notes are written from |
| `sentences[]`   | per sentence: `raw`, `clean`, `label`, `reason`                   |

### The small-talk filter (`relevance.py`)

Deciding that "Are you feeling cold? Switch off the AC" carries no procedural
information is a judgement call, and it is made by a **fine-tuned classifier of
our own** — deberta-v3-small, trained on an utterance-level small-talk/business
corpus. Three layers, cheapest first:

1. a deterministic keep-override — a sentence carrying a deadline, action item,
   blocker, staffing change or client/budget reference is business whatever the
   classifier thinks, so a real decision can never be dropped;
2. the classifier, keeping everything at or above `RELEVANCE_THRESHOLD`;
3. optionally (off by default) an Ollama second opinion on the slice the
   classifier is genuinely unsure about.

Until the checkpoint exists the pass falls back to the LLM batch classifier, so
the pipeline works either way — `GET /health` reports which one is live
(`relevance_backend`: `model` or `llm`, with `relevance_note` saying why).

**Training it** (local, free, and needs Ollama only for the best results):

```bash
python build_dataset.py   # → data/relevance-dataset   (~20 min, downloads corpora)
python finetune.py        # → models/relevance-filter  (~2 h CPU, seconds on GPU)
```

`build_dataset.py` combines DailyDialog, EmpatheticDialogues, a meeting corpus
(AMI where available, otherwise MeetingBank) and QMSum, labels them
topic-prior → keyword-override → optional LLM relabel, adds synthetic edge
cases generated by Ollama ("John is out sick this week so his tasks are
blocked" — sounds personal, *is* staffing), then dedupes, balances 1:1 and
splits 80/10/10. Every example is put through the same
`cleaning.split_sentences` + `clean_text` treatment the live pipeline applies,
so the model is served the distribution it trained on. Run it with Ollama up:
without it you lose the synthetic edge cases and the relabel pass, which is
where most of the hard-case accuracy comes from.

One caveat worth knowing: DailyDialog's topic annotation exists only in the
original release, whose host is now a parked domain, and no Hub mirror carries
the column. The topic prior is still implemented and used when a source provides
`topic`; otherwise the layers underneath it (keyword override + LLM relabel) do
that work. See the comment above `BUSINESS_TOPICS` in `build_dataset.py`.

| Var                         | Default                    | Purpose                                          |
| --------------------------- | -------------------------- | ------------------------------------------------ |
| `RELEVANCE`                 | `1`                        | `0` keeps every sentence                          |
| `RELEVANCE_BACKEND`         | `auto`                     | `auto` \| `model` \| `llm`                        |
| `RELEVANCE_MODEL_PATH`      | `backend/models/relevance-filter` | fine-tuned checkpoint             |
| `RELEVANCE_THRESHOLD`       | `0.60`                     | min P(business) to keep a sentence                |
| `RELEVANCE_DEVICE`          | `-1`                       | `-1` CPU, `0`+ that CUDA device                   |
| `RELEVANCE_INFER_BATCH`     | `32`                       | sentences per forward pass                        |
| `RELEVANCE_ESCALATE`        | `0`                        | `1` asks Ollama about low-confidence sentences    |
| `RELEVANCE_ESCALATE_BELOW`  | `0.75`                     | confidence under which to escalate                |
| `RELEVANCE_MODEL`           | `OLLAMA_MODEL`             | LLM for the fallback / escalation                 |
| `RELEVANCE_BATCH`           | `30`                       | sentences per LLM request                         |

Lower `RELEVANCE_THRESHOLD` if real content is being dropped; raise it if small
talk is leaking through.

### The rewrite pass (`rewrite.py`)

Dropping small talk out of the middle of a turn can leave it reading in
fragments, and fragments are what make a local summarizer produce mush. This
pass rewrites each turn's business text into plain grammatical sentences — and
only that: no new facts, no summarising, no merging turns, speaker and
timestamps untouched. It writes `polished` and leaves `relevant` alone, because
that is what the transcript UI renders and what the raw↔clean word diff needs.

Every rewrite is checked before it is accepted: a candidate that drops too much
of the original's content words, changes length materially, or introduces a
number or a capitalised name that wasn't in the source is rejected and the turn
keeps its original wording. The count of accepted rewrites is logged per run.

| Var             | Default        | Purpose                                  |
| --------------- | -------------- | ---------------------------------------- |
| `REWRITE`       | `1`            | `0` skips the pass                        |
| `REWRITE_MODEL` | `OLLAMA_MODEL` | model to rewrite with                     |
| `REWRITE_CHARS` | `2500`         | characters of transcript per request      |

## Notes

- The first run downloads the Whisper model and the pyannote weights; expect a
  delay and disk usage.
- `data/` and `models/` are gitignored: the relevance dataset is derived from
  public corpora and the checkpoint is ~570 MB. Rebuild both with
  `build_dataset.py` + `finetune.py`.
- CPU diarization works but is slow on long files; use `WHISPER_DEVICE=cuda`
  with a GPU for real speed.
- Denoising costs roughly 1/20th of the recording's length on a 16-core CPU
  (a 16-minute file takes ~45 s), which is small next to diarization. Long
  files are split into `DEEPFILTER_CHUNK_SEC` windows denoised in parallel;
  each window is given 2 s of real lead-in audio for model context that is
  then discarded, so the seams stay sample-exact.
