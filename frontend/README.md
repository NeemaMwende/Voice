# EchoNotes — Audio → Transcript → Notes

A Next.js (App Router + TypeScript + Tailwind) dashboard for uploading audio,
transcribing it, and generating structured notes. Dark + neon UI with animated
upload flow, live waveform, progress bar, audio playback, and a searchable
recordings/notes library.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:3000

## Sections

- **Overview** — stats (recordings, minutes transcribed, notes) + recent activity
- **Upload & Transcribe** — drag-drop upload, animated progress, live transcript, notes
- **Recordings** — searchable library with playback and delete
- **Notes** — browse every generated note set with summary / transcript / key points tabs

## Demo mode

Transcription is **simulated** so it runs entirely in the browser with no keys.
State is held in a React context (`context/AppContext.tsx`) and shared across tabs.

### Going live

In `app/upload/page.tsx`, the `handle()` function drives a fake pipeline
(`uploading → transcribing → analyzing`). To use real speech-to-text:

1. Replace the `transcribing` stage with a call to your API (OpenAI Whisper,
   Deepgram, AssemblyAI, etc.), sending the uploaded `File`.
2. Feed the returned transcript into a summarization step (or an LLM) to build
   the `summary` / `key` / `tags` fields.
3. Pass the real result into `addRecording()` instead of `pickDemo()`.
# Voice
