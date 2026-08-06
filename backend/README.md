# DAXA Backend

Accepts an audio upload and returns a transcript split into **speaker-labeled
segments**. Transcription is done by [faster-whisper]; speaker diarization by
[pyannote/speaker-diarization-3.1]. The two are combined in `main.py`
(`diarization.py` holds the pyannote pipeline).

[faster-whisper]: https://github.com/SYSTRAN/faster-whisper
[pyannote/speaker-diarization-3.1]: https://huggingface.co/pyannote/speaker-diarization-3.1

## Setup

```bash
cd backend
python3 -m venv venv
source venv/bin/activate          # Windows: .\venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r requirements.txt
```

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

## Notes

- The first run downloads the Whisper model and the pyannote weights; expect a
  delay and disk usage.
- CPU diarization works but is slow on long files; use `WHISPER_DEVICE=cuda`
  with a GPU for real speed.
