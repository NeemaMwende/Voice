# EchoNotes Backend

This backend service accepts audio uploads and returns a transcription with speaker-labeled segments.

## Setup

1. Create a Python virtual environment:

   ```powershell
   cd backend
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install --upgrade pip
   pip install -r requirements.txt
   ```

2. Start the backend:

   ```powershell
   uvicorn main:app --reload --host 0.0.0.0 --port 8000
   ```

3. Upload an audio file to `http://localhost:8000/transcribe`.

## Notes

- `faster-whisper` is used for transcription.
- This service can return a speaker-labeled transcript via `speakerSegments`.
- The PyPI package `pynote` currently appears to be a placeholder package and does not provide a working diarization API.
- If you have a real speaker diarization library, replace the placeholder `diarize_audio` implementation in `main.py`.
