"use client";

import { useRef, useState } from "react";
import { useApp, Recording } from "@/context/AppContext";
import { pickDemo, fmtSize } from "@/lib/demo";
import { IconMic } from "@/components/icons";
import NotesViewer from "@/components/NotesViewer";
import { toast } from "@/components/Toast";

type Stage = "idle" | "uploading" | "transcribing" | "analyzing" | "done";

const WAVE_BARS = Array.from({ length: 44 });

export default function UploadPage() {
  const { addRecording } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [pct, setPct] = useState(0);
  const [file, setFile] = useState<{ name: string; size: number; url: string } | null>(null);
  const [result, setResult] = useState<Recording | null>(null);
  const busy = stage !== "idle" && stage !== "done";

  const animate = (dur: number, onDone: () => void) => {
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      setPct(Math.round(100 * (0.5 - Math.cos(p * Math.PI) / 2)));
      if (p < 1) requestAnimationFrame(step);
      else onDone();
    };
    requestAnimationFrame(step);
  };

  const handle = (f: File) => {
    if (busy) return;
    const okType = f.type.startsWith("audio/") || /\.(mp3|wav|m4a|ogg|webm|aac|flac)$/i.test(f.name);
    if (!okType) {
      toast("Please upload an audio file");
      return;
    }
    const url = URL.createObjectURL(f);
    setFile({ name: f.name, size: f.size, url });
    setResult(null);
    setPct(0);
    setStage("uploading");

    animate(1300, () => {
      setStage("transcribing");
      setPct(0);
      animate(2400, () => {
        setStage("analyzing");
        setPct(0);
        animate(1500, () => {
          const demo = pickDemo();
          const rec: Recording = {
            ...demo,
            id: crypto.randomUUID(),
            fileName: f.name,
            sizeBytes: f.size,
            createdAt: Date.now(),
            audioUrl: url,
          };
          setResult(rec);
          addRecording(rec);
          setStage("done");
          toast("Notes generated");
        });
      });
    });
  };

  const stageLabel: Record<Stage, string> = {
    idle: "",
    uploading: "Uploading…",
    transcribing: "Transcribing…",
    analyzing: "Generating notes…",
    done: "✓ Complete",
  };
  const pctLabel: Record<Stage, string> = {
    idle: "",
    uploading: "uploaded",
    transcribing: "transcribed",
    analyzing: "analyzed",
    done: "done",
  };

  return (
    <div>
      <PageHeader title="Upload & Transcribe" subtitle="Drop a recording — we'll transcribe it and pull out the key notes." />

      <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-6">
        {/* Upload card */}
        <div className="rounded-3xl border border-white/[0.08] bg-panel backdrop-blur-xl shadow-card p-7">
          <div
            onClick={() => !busy && inputRef.current?.click()}
            onDragEnter={(e) => { e.preventDefault(); setDrag(true); }}
            onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
            onDragLeave={(e) => { e.preventDefault(); setDrag(false); }}
            onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files[0]) handle(e.dataTransfer.files[0]); }}
            className={`cursor-pointer rounded-2xl border-2 border-dashed p-10 text-center transition-all ${
              drag
                ? "border-neon3 bg-neon3/10 shadow-[inset_0_0_40px_-8px_rgba(255,78,205,0.5)]"
                : "border-neon/40 hover:border-neon2 bg-gradient-to-b from-neon/5 to-transparent hover:-translate-y-0.5"
            }`}
          >
            <div className="mx-auto mb-4 grid h-[74px] w-[74px] place-items-center rounded-full bg-[radial-gradient(circle_at_30%_30%,#7c5cff,#3a1a8a)] animate-pulse2">
              <IconMic className="w-8 h-8 text-white" />
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
              onChange={(e) => e.target.files?.[0] && handle(e.target.files[0])}
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
                {stage === "done" ? "100% · done" : `${pct}% ${pctLabel[stage]}`}
              </div>
              {file.url && stage !== "idle" && (
                <audio src={file.url} controls className="mt-4 w-full rounded-xl" />
              )}
            </div>
          )}
        </div>

        {/* Notes card */}
        <div className="rounded-3xl border border-white/[0.08] bg-panel backdrop-blur-xl shadow-card p-7">
          <h2 className="text-[15px] font-semibold mb-1">Generated Notes</h2>
          <p className="text-[12.5px] text-muted mb-5">
            Transcript &amp; AI summary appear here once processing finishes.
          </p>
          {result ? (
            <NotesViewer rec={result} />
          ) : (
            <div className="text-center text-muted py-14 text-[13px]">
              {busy ? "Working on it…" : "No notes yet — upload an audio file to get started."}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-7">
      <h1 className="text-[26px] font-bold tracking-tight">{title}</h1>
      <p className="text-[13.5px] text-muted mt-1">{subtitle}</p>
    </div>
  );
}
