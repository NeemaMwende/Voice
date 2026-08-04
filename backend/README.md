# EchoNotes Backend

Accepts an audio upload and returns a transcript split into **speaker-labeled
segments**. Transcription is done by [faster-whisper]; speaker diarization by
[pyannote/speaker-diarization-3.1]. The two are combined in `main.py`
(`diarization.py` holds the pyannote pipeline).

Before either of them runs, the audio is cleaned up in two passes:

```
upload → DeepFilterNet (denoise.py) → Silero VAD (vad.py) → Whisper + pyannote
             remove noise                remove silence
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

- `GET /health` — model + diarization status.
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

### Silence trimming (`vad.py`)

| Var                  | Default | Purpose                                        |
| -------------------- | ------- | ---------------------------------------------- |
| `SILERO_VAD`         | `1`     | `0` skips the VAD pre-pass entirely            |
| `SILERO_VAD_ONNX`    | `1`     | `0` uses the PyTorch weights instead of ONNX   |
| `VAD_THRESHOLD`      | `0.3`   | speech probability cutoff, 0–1                 |
| `VAD_MIN_SILENCE_MS` | `1000`  | silence this long ends a speech chunk          |
| `VAD_SPEECH_PAD_MS`  | `400`   | padding kept either side of speech             |
| `VAD_MIN_SPEECH_MS`  | `0`     | drop speech chunks shorter than this           |

## Notes

- The first run downloads the Whisper model and the pyannote weights; expect a
  delay and disk usage.
- CPU diarization works but is slow on long files; use `WHISPER_DEVICE=cuda`
  with a GPU for real speed.
- Denoising costs roughly 1/20th of the recording's length on a 16-core CPU
  (a 16-minute file takes ~45 s), which is small next to diarization. Long
  files are split into `DEEPFILTER_CHUNK_SEC` windows denoised in parallel;
  each window is given 2 s of real lead-in audio for model context that is
  then discarded, so the seams stay sample-exact.
