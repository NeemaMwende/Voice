"use client";

import { useEffect, useRef, useState } from "react";
import { useApp, Recording } from "@/context/AppContext";
import { fmtSize, NoteSection, SentenceSpan, Speaker, Segment } from "@/lib/notes";
import { IconMic, IconUpload } from "@/components/icons";
import NotesViewer from "@/components/NotesViewer";
import LiveRecorder from "@/components/LiveRecorder";
import PageHeader from "@/components/PageHeader";
import { toast } from "@/components/Toast";

type Stage =
  | "idle"
  | "uploading"
  | "transcribing"
  | "diarizing"
  | "naming"
  | "analyzing"
  | "done";
type Mode = "upload" | "record";

type TranscriptionSegment = {
  speaker: string;
  start: number;
  end: number;
  /** verbatim — fillers, stutters and noise tags included */
  text: string;
  confidence?: number | null;
  words?: { start: number; end: number; text: string; p: number | null }[];
  /** the same turn de-noised; "" when the turn was nothing but filler */
  clean?: string;
  /** business content only, small talk removed */
  relevant?: string;
  sentences?: SentenceSpan[];
};

type TranscriptionResponse = {
  transcript: string;
  segments: TranscriptionSegment[];
  language: string;
  duration: number | null;
  summary?: string | null;
  /** prose account of the business content — the SOP's source text */
  business_summary?: string | null;
  key_points?: string[];
  action_items?: string[];
  insights?: NoteSection[];
  outline?: NoteSection[];
  audio_url?: string | null;
  overlaps?: { start: number; end: number }[];
  peaks?: number[] | null;
};

/** What GET /progress/<job_id> returns while a transcription is running. */
type JobProgress = { pct: number; stage: string; label: string; done: boolean };

const SERVER_STAGES: Record<string, Stage> = {
  queued: "uploading",
  uploading: "uploading",
  transcribing: "transcribing",
  diarizing: "diarizing",
  naming: "naming",
  analyzing: "analyzing",
};

/**
 * POST the form over XHR rather than fetch — XHR is the only way to observe
 * real upload byte progress, which is what drives the bar's first stretch.
 */
function postWithUploadProgress(
  url: string,
  form: FormData,
  onProgress: (fraction: number) => void
): Promise<TranscriptionResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.responseType = "json";

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.upload.onload = () => onProgress(1);

    xhr.onload = () => {
      const body = xhr.response;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as TranscriptionResponse);
        return;
      }
      const detail =
        typeof body?.detail === "string" ? body.detail : `Transcription failed (${xhr.status})`;
      reject(new Error(detail));
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.onabort = () => reject(new Error("upload aborted"));

    xhr.send(form);
  });
}

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

  // Every tier comes from the backend: `text` is verbatim, `clean` drops the
  // fillers, `relevant` additionally drops the small talk, and `sentences`
  // records which is which. Older responses only had `text`, so fall back.
  const segments: Segment[] = response.segments.map((s) => ({
    speakerId: slugifySpeaker(s.speaker),
    tSec: s.start,
    endSec: s.end,
    raw: s.text.trim(),
    clean: (s.clean ?? s.text).trim(),
    confidence: s.confidence ?? null,
    words: s.words ?? undefined,
    relevant: s.relevant ?? undefined,
    sentences: s.sentences?.length ? s.sentences : undefined,
  }));

  // AI-generated note sections (Ollama). Each is best-effort on the backend,
  // so any of them can come back empty; the viewer just omits what's missing.
  const keyPoints = response.key_points?.filter(Boolean) ?? [];
  const actionItems = response.action_items?.filter(Boolean) ?? [];
  const insights = response.insights?.filter((s) => s?.heading) ?? [];
  const outline = response.outline?.filter((s) => s?.heading) ?? [];

  const metaFacts = [
    `Language: ${response.language || "unknown"}`,
    `Duration: ${formatTimestamp(response.duration ?? 0)}`,
    `${speakers.length} speaker${speakers.length === 1 ? "" : "s"} · ${
      response.segments.length
    } turn${response.segments.length === 1 ? "" : "s"}`,
  ];

  // The Notes tab never shows the raw transcription, so when the summarizer is
  // unavailable we say so rather than dumping the transcript in as an overview.
  const overview =
    response.summary?.trim() ||
    (response.transcript
      ? "Summarization was unavailable for this recording — open the Transcript tab to read it in full."
      : "No speech was detected in this recording.");

  return {
    id: crypto.randomUUID(),
    title,
    transcript: response.transcript || segments.map((s) => s.clean).join(" "),
    speakers,
    segments,
    summary: [{ heading: "Overview", body: overview }],
    businessSummary: response.business_summary?.trim() || undefined,
    key: keyPoints.length ? keyPoints : metaFacts,
    actionItems,
    insights,
    outline,
    tags: ["Transcription", response.language || "Unknown language"],
    durationSec: Math.round(response.duration ?? src.durationSec ?? 0),
    fileName: src.name,
    sizeBytes: src.size,
    createdAt: Date.now(),
    // Prefer the durable /media URL from the backend so playback survives a
    // reload; fall back to the local object URL if it wasn't returned.
    audioUrl: response.audio_url ? `${API_URL}${response.audio_url}` : src.url,
    // waveform envelope + crosstalk ranges, persisted so the timeline can
    // render without re-decoding the audio client-side.
    peaks: response.peaks ?? [],
    overlaps: response.overlaps ?? [],
  };
}

export default function UploadPage() {
  const { addRecording } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>("upload");
  const [drag, setDrag] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [pct, setPct] = useState(0);
  const [file, setFile] = useState<Source | null>(null);
  const [result, setResult] = useState<Recording | null>(null);
  const [speakerCount, setSpeakerCount] = useState<string>("");
  const [detail, setDetail] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const busy = stage !== "idle" && stage !== "done";

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };
  useEffect(() => stopPolling, []);

  // The bar only ever moves forward: the upload fraction and the server's
  // reported percent are two different sources, and a stalled poll shouldn't
  // make it jump backwards.
  const advance = (next: number) => setPct((prev) => Math.max(prev, Math.round(next)));

  // shared pipeline for both upload + live recording
  const process = async (src: Source) => {
    setFile(src);
    setResult(null);
    setPct(0);
    setDetail("");
    setStage("uploading");

    // The server reports progress for this id while it works; we poll it.
    const jobId = crypto.randomUUID();

    try {
      // pull the blob back out of the object URL so we can POST the real bytes
      const blob = await fetch(src.url).then((r) => r.blob());
      const form = new FormData();
      form.append("file", blob, src.name);
      form.append("job_id", jobId);
      // Tell diarization the exact speaker count when the user knows it — stops
      // pyannote from over-splitting one voice into many phantom speakers.
      const n = Number.parseInt(speakerCount, 10);
      if (Number.isFinite(n) && n > 0) form.append("num_speakers", String(n));

      // Sending the bytes is the first 10% of the bar; the server owns the rest.
      stopPolling();
      pollRef.current = setInterval(async () => {
        try {
          const res = await fetch(`${API_URL}/progress/${jobId}`);
          if (!res.ok) return;
          const p: JobProgress = await res.json();
          if (p.stage === "unknown") return;
          advance(p.pct);
          setDetail(p.label ?? "");
          const mapped = SERVER_STAGES[p.stage];
          if (mapped) setStage(mapped);
        } catch {
          // a dropped poll is harmless — the next tick catches up
        }
      }, 700);

      const transcription = await postWithUploadProgress(
        `${API_URL}/transcribe`,
        form,
        (fraction) => advance(fraction * 10)
      );

      stopPolling();
      const rec = recordingFromResponse(transcription, src);
      setResult(rec);
      addRecording(rec);
      setPct(100);
      setDetail("");
      setStage("done");
      toast("Transcription complete");
    } catch (error) {
      stopPolling();
      setStage("idle");
      setPct(0);
      setDetail("");
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
    diarizing: "Separating speakers…",
    naming: "Identifying speakers…",
    analyzing: "Preparing notes…",
    done: "✓ Complete",
  };
  const pctLabel: Record<Stage, string> = {
    idle: "",
    uploading: mode === "record" ? "captured" : "uploaded",
    transcribing: "transcribed",
    diarizing: "diarized",
    naming: "matched",
    analyzing: "analyzed",
    done: "done",
  };

  return (
    <div className="flex flex-col min-h-[calc(100vh-4rem)] lg:h-[calc(100vh-4rem)]">
      <PageHeader
        title="Capture & Transcribe"
        subtitle="Upload a file or record audio — we transcribe it, split it by speaker, and pull out the key notes."
      />

      <div className="grid flex-1 min-h-0 grid-cols-1 items-stretch gap-6 lg:grid-cols-[520px_1fr]">
        {/* Input card — scrolls if the controls outgrow a short window */}
        <div className="self-start rounded-3xl border border-white/[0.08] bg-panel backdrop-blur-xl shadow-card p-7 lg:max-h-full lg:overflow-y-auto">
          {/* mode switch */}
          <div className="mb-6 flex gap-1.5 rounded-2xl bg-overlay/[0.04] p-1.5">
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
                    : "text-muted hover:text-fg"
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
          <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl bg-overlay/[0.03] px-4 py-3">
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
              className="w-20 shrink-0 rounded-xl border border-overlay/10 bg-overlay/[0.05] px-3 py-2 text-center text-sm font-semibold text-fg outline-none transition-colors focus:border-neon2 disabled:opacity-50"
            />
          </div>

          {/* waveform */}
          <div className={`flex items-center justify-center gap-1 overflow-hidden transition-all ${busy && stage !== "uploading" ? "h-[54px] mt-5" : "h-0"}`}>
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
              <div className="h-2.5 rounded-full bg-overlay/[0.07] overflow-hidden">
                <div
                  className="h-full rounded-full bg-[linear-gradient(90deg,#7c5cff,#00e5ff,#ff4ecd)] bg-[length:200%_100%] animate-flow transition-[width] duration-300"
                  style={{ width: `${stage === "done" ? 100 : pct}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-3 text-[11.5px] text-muted">
                <span className="truncate">{stage === "done" ? "" : detail}</span>
                <span className="shrink-0">
                  {stage === "done" ? "100% · done" : `${pct}% ${pctLabel[stage]}`}
                </span>
              </div>
              {file.url && stage !== "idle" && stage !== "done" && (
                <audio src={file.url} controls className="mt-4 w-full rounded-xl" />
              )}
            </div>
          )}
        </div>

        {/* Notes card */}
        <div className="flex flex-col rounded-3xl border border-overlay/[0.08] bg-panel backdrop-blur-xl shadow-card p-7">
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
