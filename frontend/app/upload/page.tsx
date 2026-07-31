"use client";

import { useRef, useState } from "react";
import { useApp, Recording } from "@/context/AppContext";
import { fmtSize, Speaker, Segment } from "@/lib/notes";
import { IconMic, IconUpload } from "@/components/icons";
import NotesViewer from "@/components/NotesViewer";
import LiveRecorder from "@/components/LiveRecorder";
import PageHeader from "@/components/PageHeader";
import { toast } from "@/components/Toast";

type Stage = "idle" | "uploading" | "transcribing" | "analyzing" | "done";
type Mode = "upload" | "record";

type TranscriptionSegment = {
  speaker: string;
  start: number;
  end: number;
  text: string;
};

type TranscriptionResponse = {
  transcript: string;
  segments: TranscriptionSegment[];
  language: string;
  duration: number | null;
  summary?: string | null;
  key_points?: string[];
  audio_url?: string | null;
};

const WAVE_BARS = Array.from({ length: 44 });
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";
const SPEAKER_COLORS = ["#7c5cff", "#00e5ff", "#ff4ecd", "#2ee6a6", "#ffb454"];

function formatTimestamp(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

const slugifySpeaker = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "speaker";

type Source = { name: string; size: number; url: string; durationSec?: number };

function recordingFromResponse(response: TranscriptionResponse, src: Source): Recording {
  const title = src.name.replace(/\.[^.]+$/, "") || "Untitled recording";

  // distinct speakers, in first-seen order → colored Speaker[]
  const order: string[] = [];
  for (const s of response.segments) {
    if (!order.includes(s.speaker)) order.push(s.speaker);
  }
  const speakers: Speaker[] = (order.length ? order : ["Speaker 1"]).map((name, i) => ({
    id: slugifySpeaker(name),
    name,
    color: SPEAKER_COLORS[i % SPEAKER_COLORS.length],
  }));

  // backend returns cleaned text only, so raw === clean (no noise diff to show)
  const segments: Segment[] = response.segments.map((s) => ({
    speakerId: slugifySpeaker(s.speaker),
    tSec: s.start,
    endSec: s.end,
    raw: s.text.trim(),
    clean: s.text.trim(),
  }));

  // AI-generated key points (Ollama). Fall back to metadata if unavailable.
  const keyPoints = response.key_points?.filter(Boolean) ?? [];
  const overview =
    response.summary?.trim() ||
    response.transcript ||
    "No speech was detected in this recording.";

  const metaFacts = [
    `Language: ${response.language || "unknown"}`,
    `Duration: ${formatTimestamp(response.duration ?? 0)}`,
    `${speakers.length} speaker${speakers.length === 1 ? "" : "s"} · ${
      response.segments.length
    } turn${response.segments.length === 1 ? "" : "s"}`,
  ];

  return {
    id: crypto.randomUUID(),
    title,
    transcript: response.transcript || segments.map((s) => s.clean).join(" "),
    speakers,
    segments,
    summary: [
      { heading: "Overview", body: overview },
      ...(keyPoints.length
        ? [{ heading: "Key points", bullets: keyPoints }]
        : []),
    ],
    key: keyPoints.length ? keyPoints : metaFacts,
    tags: ["Transcription", response.language || "Unknown language"],
    durationSec: Math.round(response.duration ?? src.durationSec ?? 0),
    fileName: src.name,
    sizeBytes: src.size,
    createdAt: Date.now(),
    // Prefer the durable /media URL from the backend so playback survives a
    // reload; fall back to the local object URL if it wasn't returned.
    audioUrl: response.audio_url ? `${API_URL}${response.audio_url}` : src.url,
  };
}

export default function UploadPage() {
  const { addRecording } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("upload");
  const [drag, setDrag] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [pct, setPct] = useState(0);
  const [phase, setPhase] = useState<string>("");
  const [file, setFile] = useState<Source | null>(null);
  const [result, setResult] = useState<Recording | null>(null);
  const [speakerCount, setSpeakerCount] = useState<string>("");
  const busy = stage !== "idle" && stage !== "done";

  // shared pipeline for both upload + live recording
  const process = async (src: Source) => {
    setFile(src);
    setResult(null);
    setPct(0);
    setStage("uploading");

    try {
      // pull the blob back out of the object URL so we can POST the real bytes
      const blob = await fetch(src.url).then((r) => r.blob());
      const form = new FormData();
      form.append("file", blob, src.name);
      // Tell diarization the exact speaker count when the user knows it — stops
      // pyannote from over-splitting one voice into many phantom speakers.
      const n = parseInt(speakerCount, 10);
      if (Number.isFinite(n) && n > 0) form.append("num_speakers", String(n));

      setStage("transcribing");
      setPct(2);

      // Submit — backend returns a progress_id immediately
      const submitRes = await fetch(`${API_URL}/transcribe`, { method: "POST", body: form });
      if (!submitRes.ok) {
        const errorBody = await submitRes.json().catch(() => null);
        const detail =
          typeof errorBody?.detail === "string"
            ? errorBody.detail
            : `Transcription failed (${submitRes.status})`;
        throw new Error(detail);
      }

      const { progress_id } = await submitRes.json();

      // Poll progress every 500ms
      const poll = setInterval(async () => {
        try {
          const res = await fetch(`${API_URL}/transcribe/progress/${progress_id}`);
          const data = await res.json();
          if (data.status === "error") {
            clearInterval(poll);
            throw new Error(data.error || "Transcription failed");
          }
          setPct(data.pct);
          if (data.status === "diarizing") {
            setPhase("Identifying speakers…");
          } else if (data.status === "summarizing") {
            setPhase("Summarizing…");
          }
          if (data.status === "complete" && data.result) {
            clearInterval(poll);
            setStage("analyzing");
            setPct(100);
            const transcription: TranscriptionResponse = data.result;
            const rec = recordingFromResponse(transcription, src);
            setResult(rec);
            addRecording(rec);
            setStage("done");
            toast("Transcription complete");
          }
        } catch (err) {
          clearInterval(poll);
          throw err;
        }
      }, 500);
    } catch (error) {
      setStage("idle");
      setPct(0);
      toast(
        error instanceof Error && error.message.startsWith("Transcription failed")
          ? error.message
          : "Couldn't reach the transcription service. Is the backend running?"
      );
    }
  };

  const handleFile = (f: File) => {
    if (busy) return;
    const okType = f.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|webm|aac|flac)$/i.test(f.name);
    if (!okType) {
      toast("Please upload an audio file");
      return;
    }
    void process({ name: f.name, size: f.size, url: URL.createObjectURL(f) });
  };

  const stageLabel: Record<Stage, string> = {
    idle: "",
    uploading: mode === "record" ? "Capturing…" : "Uploading…",
    transcribing: "Transcribing…",
    analyzing: "Preparing notes…",
    done: "✓ Complete",
  };
  const pctLabel: Record<Stage, string> = {
    idle: "",
    uploading: mode === "record" ? "captured" : "uploaded",
    transcribing: "transcribed",
    analyzing: "analyzed",
    done: "done",
  };

  return (
    <div className="flex flex-col min-h-[calc(100vh-4rem)]">
      <PageHeader
        title="Capture & Transcribe"
        subtitle="Upload a file or record audio — we transcribe it, split it by speaker, and pull out the key notes."
      />

      <div className="grid flex-1 grid-cols-1 items-stretch gap-6 lg:grid-cols-[520px_1fr]">
        {/* Input card */}
        <div className="self-start rounded-3xl border border-white/[0.08] bg-panel backdrop-blur-xl shadow-card p-7">
          {/* mode switch */}
          <div className="mb-6 flex gap-1.5 rounded-2xl bg-white/[0.04] p-1.5">
            {([
              { m: "upload" as const, label: "Upload file", Icon: IconUpload },
              { m: "record" as const, label: "Record & transcribe", Icon: IconMic },
            ]).map(({ m, label, Icon }) => (
              <button
                key={m}
                onClick={() => !busy && setMode(m)}
                disabled={busy}
                className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-[13px] font-semibold transition-all disabled:cursor-not-allowed ${
                  mode === m
                    ? "bg-gradient-to-br from-neon to-neon2 text-white shadow-[0_6px_18px_-6px_#7c5cff]"
                    : "text-muted hover:text-white"
                }`}
              >
                <Icon className="h-4 w-4" /> {label}
              </button>
            ))}
          </div>

          {mode === "upload" ? (
            <div
              onClick={() => !busy && inputRef.current?.click()}
              onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
              onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
              onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
              onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); }}
              className={`cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center transition-all ${
                drag
                  ? "border-neon3 bg-neon3/10 shadow-[inset_0_0_40px_-8px_rgba(255,78,205,0.5)]"
                  : "border-neon/40 hover:border-neon2 bg-gradient-to-b from-neon/5 to-transparent hover:-translate-y-0.5"
              }`}
            >
              <div className="mx-auto mb-4 grid h-[74px] w-[74px] place-items-center rounded-full bg-[radial-gradient(circle_at_30%_30%,#7c5cff,#3a1a8a)] animate-pulse2">
                <IconUpload className="w-8 h-8 text-white" />
              </div>
              <div className="text-lg font-semibold mb-1.5">Drag &amp; drop your audio here</div>
              <div className="text-[13px] text-muted">
                or <span className="text-neon2 underline underline-offset-4">browse files</span>
              </div>
              <div className="mt-3.5 text-[11px] text-muted tracking-wide">
                MP3 · WAV · M4A · OGG · WEBM — up to 200 MB
              </div>
              <input
                ref={inputRef}
                type="file"
                accept="audio/*"
                hidden
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
            </div>
          ) : (
            <LiveRecorder
              disabled={busy}
              onComplete={(src) => void process(src)}
            />
          )}

          {/* expected speakers — optional hint for diarization */}
          <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl bg-white/[0.03] px-4 py-3">
            <div className="min-w-0">
              <div className="text-[13px] font-semibold">Expected speakers</div>
              <div className="text-[11px] text-muted">
                Know how many people are talking? Set it so voices don&apos;t get over-split.
              </div>
            </div>
            <input
              type="number"
              min={1}
              max={20}
              inputMode="numeric"
              placeholder="Auto"
              value={speakerCount}
              disabled={busy}
              onChange={(e) => setSpeakerCount(e.target.value)}
              className="w-20 shrink-0 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-center text-sm font-semibold text-white outline-none transition-colors focus:border-neon2 disabled:opacity-50"
            />
          </div>

          {/* waveform */}
          <div className={`flex items-center justify-center gap-1 overflow-hidden transition-all ${stage === "transcribing" ? "h-[54px] mt-5" : "h-0"}`}>
            {WAVE_BARS.map((_, i) => (
              <span
                key={i}
                className="w-1 rounded bg-gradient-to-b from-neon2 to-neon animate-bar"
                style={{ animationDelay: `${i * 0.045}s`, height: "8px" }}
              />
            ))}
          </div>

          {/* progress */}
          {file && (
            <div className="mt-5 animate-fade">
              <div className="flex items-center gap-3 mb-3.5">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-neon/15">
                  <IconMic className="w-5 h-5 text-neon" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm font-semibold">{file.name}</div>
                  <div className="text-[11.5px] text-muted">{fmtSize(file.size)}</div>
                </div>
                <div className={`text-xs whitespace-nowrap ${stage === "done" ? "text-ok" : "text-neon2"}`}>
                  {stageLabel[stage]}
                </div>
              </div>
              <div className="h-2.5 rounded-full bg-white/[0.07] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[linear-gradient(90deg,#7c5cff,#00e5ff,#ff4ecd)] bg-[length:200%_100%] animate-flow transition-[width] duration-300"
                  style={{ width: `${stage === "done" ? 100 : pct}%` }}
                />
              </div>
              <div className="mt-1.5 text-right text-[11.5px] text-muted">
                {stage === "done" ? "100% · done" : phase || `${pct}% ${pctLabel[stage]}`}
              </div>
              {file.url && stage !== "idle" && stage !== "done" && (
                <audio src={file.url} controls className="mt-4 w-full rounded-xl" />
              )}
            </div>
          )}
        </div>

        {/* Notes card */}
        <div className="flex flex-col rounded-3xl border border-white/[0.08] bg-panel backdrop-blur-xl shadow-card p-7">
          <h2 className="text-[15px] font-semibold mb-1">Generated Notes</h2>
          <p className="text-[12.5px] text-muted mb-5">
            Speaker-split transcript &amp; AI summary appear here once processing finishes.
          </p>
          {result ? (
            <div className="min-h-0 flex-1">
              <NotesViewer
                rec={result}
                audioUrl={file!.url}
                onRecChange={(updated) => {
                  setResult(updated);
                  addRecording(updated);
                }}
              />
            </div>
          ) : (
            <div className="grid flex-1 place-items-center text-center text-muted text-[13px]">
              <span>
                {busy
                  ? "Working on it…"
                  : mode === "record"
                  ? "No notes yet — hit record to get started."
                  : "No notes yet — upload an audio file to get started."}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
