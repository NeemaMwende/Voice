"use client";

import { useState } from "react";
import { Recording } from "@/context/AppContext";
import { IconCopy, IconDownload } from "./icons";
import { toast } from "./Toast";

const TABS = ["Notes", "Transcript", "Key Points"] as const;

export default function NotesViewer({ rec }: { rec: Recording }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Notes");

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
    <div className="animate-fade">
      <div className="flex gap-1.5 bg-white/[0.04] p-1.5 rounded-xl mb-4">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2.5 text-xs font-semibold rounded-lg transition-all ${
              tab === t
                ? "bg-gradient-to-br from-neon to-neon2 text-white shadow-[0_6px_18px_-6px_#7c5cff]"
                : "text-muted hover:text-white"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="max-h-[360px] overflow-auto pr-2 text-sm leading-relaxed">
        {tab === "Notes" && (
          <div>
            {rec.summary.map((s, i) => (
              <div key={i} className="mb-4">
                <h4 className="text-[11px] uppercase tracking-[0.08em] text-neon2 mb-2">
                  {s.heading}
                </h4>
                {s.body && <p className="text-[#cfd3f0]">{s.body}</p>}
                {s.bullets && (
                  <ul className="list-disc ml-5 text-[#d3d7f5] space-y-1.5">
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
                  className="text-[11px] px-2.5 py-1 rounded-full bg-neon2/10 text-neon2 border border-neon2/20"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>
        )}

        {tab === "Transcript" && (
          <p className="text-[#cfd3f0] whitespace-pre-wrap leading-7">{rec.transcript}</p>
        )}

        {tab === "Key Points" && (
          <div>
            <h4 className="text-[11px] uppercase tracking-[0.08em] text-neon2 mb-2">
              Key Points &amp; Action Items
            </h4>
            <ul className="list-disc ml-5 text-[#d3d7f5] space-y-2">
              {rec.key.map((k, i) => (
                <li key={i}>{k}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="flex gap-2.5 mt-5">
        <button
          onClick={copy}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold bg-gradient-to-br from-neon to-neon2 text-white hover:-translate-y-0.5 transition-transform"
        >
          <IconCopy className="w-4 h-4" /> Copy notes
        </button>
        <button
          onClick={download}
          className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-semibold bg-white/[0.06] border border-white/10 hover:bg-white/[0.1] transition-colors"
        >
          <IconDownload className="w-4 h-4" /> Download
        </button>
      </div>
    </div>
  );
}
