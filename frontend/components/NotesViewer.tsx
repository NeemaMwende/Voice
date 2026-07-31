"use client";

import { useState, useRef } from "react";
import { Recording } from "@/context/AppContext";
import { IconCopy, IconDownload } from "./icons";
import { toast } from "./Toast";
import TranscriptView from "./TranscriptView";

const TABS = ["Notes", "Transcript", "Key Points"] as const;

export default function NotesViewer({ rec, audioUrl, onRecChange }: { rec: Recording; audioUrl?: string; onRecChange?: (updated: Recording) => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Notes");
  const audioRef = useRef<HTMLAudioElement>(null);

  const plain = () =>
    [
      rec.title,
      "",
      ...rec.summary.map((s) =>
        s.bullets ? `${s.heading}\n- ${s.bullets.join("\n- ")}` : `${s.heading}\n${s.body}`
      ),
      "",
      "KEY POINTS",
      ...rec.key.map((k) => `- ${k}`),
      "",
      "TRANSCRIPT",
      rec.transcript,
    ].join("\n");

  const copy = () => {
    navigator.clipboard?.writeText(plain()).then(
      () => toast("Notes copied to clipboard"),
      () => toast("Copy not available")
    );
  };

  const download = () => {
    const blob = new Blob([plain()], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${rec.title.replace(/\s+/g, "-").toLowerCase()}-notes.txt`;
    a.click();
    toast("Downloaded notes");
  };

  return (
    <div className="animate-fade flex h-full min-h-0 flex-col">
      <div className="flex gap-1.5 bg-overlay/[0.04] p-1.5 rounded-xl mb-4 shrink-0">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2.5 text-[13px] font-semibold rounded-lg transition-all ${
              tab === t
                ? "bg-gradient-to-br from-neon to-neon2 text-white shadow-[0_6px_18px_-6px_#7c5cff]"
                : "text-muted hover:text-fg"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {audioUrl && (
        <audio ref={audioRef} src={audioUrl} controls className="mb-4 w-full rounded-xl shrink-0" />
      )}

      <div className="flex-1 min-h-0 overflow-auto pr-2 text-[15px] leading-7">
        {tab === "Notes" && (
          <div>
            {rec.summary.map((s, i) => (
              <div key={i} className="mb-5">
                <h4 className="text-[12px] uppercase tracking-[0.08em] text-neon2 mb-2">
                  {s.heading}
                </h4>
                {s.body && <p className="text-fg/80">{s.body}</p>}
                {s.bullets && (
                  <ul className="list-disc ml-5 text-fg/80 space-y-2">
                    {s.bullets.map((b, j) => (
                      <li key={j}>{b}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
            <div className="flex flex-wrap gap-2 mt-3">
              {rec.tags.map((t) => (
                <span
                  key={t}
                  className="text-[12px] px-2.5 py-1 rounded-full bg-neon2/10 text-neon2 border border-neon2/20"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        {tab === "Transcript" && (
          <TranscriptView
            rec={rec}
            audioRef={audioRef}
            onSpeakersChange={(speakers) => onRecChange?.({ ...rec, speakers })}
          />
        )}

        {tab === "Key Points" && (
          <div>
            <h4 className="text-[12px] uppercase tracking-[0.08em] text-neon2 mb-2">
              Key Points &amp; Action Items
            </h4>
            <ul className="list-disc ml-5 text-fg/80 space-y-2.5">
              {rec.key.map((k, i) => (
                <li key={i}>{k}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex gap-2.5 shrink-0 mt-4 pt-4 border-t border-overlay/[0.08]">
        <button
          onClick={copy}
          className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-[13px] font-semibold bg-gradient-to-br from-neon to-neon2 text-white hover:-translate-y-0.5 transition-transform"
        >
          <IconCopy className="w-4 h-4" /> Copy notes
        </button>
        <button
          onClick={download}
          className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl text-[13px] font-semibold bg-overlay/[0.06] border border-overlay/10 hover:bg-overlay/[0.1] transition-colors"
        >
          <IconDownload className="w-4 h-4" /> Download
        </button>
      </div>
    </div>
  );
}
