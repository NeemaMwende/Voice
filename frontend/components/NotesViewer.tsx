"use client";

import { ReactNode, useRef, useState } from "react";
import { Recording } from "@/context/AppContext";
import { NoteSection } from "@/lib/notes";
import {
  IconCheckSquare,
  IconCopy,
  IconDownload,
  IconList,
  IconNotes,
  IconSparkle,
} from "./icons";
import { toast } from "./Toast";
import TranscriptView from "./TranscriptView";

/**
 * Two tabs, deliberately: "Notes" is the derived material only — overview, key
 * points, insights, action items and the outline — while "Transcript" is the
 * only place the verbatim transcription appears.
 */
const TABS = ["Notes", "Transcript"] as const;

export default function NotesViewer({ rec, audioUrl, onRecChange }: { rec: Recording; audioUrl?: string; onRecChange?: (updated: Recording) => void }) {
  const [tab, setTab] = useState<(typeof TABS)[number]>("Notes");
  const audioRef = useRef<HTMLAudioElement>(null);
  const [checked, setChecked] = useState<Record<number, boolean>>({});

  const overview = rec.summary ?? [];
  const keyPoints = rec.key ?? [];
  const actionItems = rec.actionItems ?? [];
  const insights = rec.insights ?? [];
  const outline = rec.outline ?? [];
  const hasNotes =
    overview.length + keyPoints.length + actionItems.length + insights.length + outline.length > 0;

  const sectionLines = (sections: NoteSection[]) =>
    sections.flatMap((s) => [
      s.heading.toUpperCase(),
      ...(s.body ? [s.body] : []),
      ...(s.bullets ?? []).map((b) => `- ${b}`),
      "",
    ]);

  // Plain-text export mirrors the Notes tab: no raw transcript, same order.
  const plain = () =>
    [
      rec.title,
      "",
      ...sectionLines(overview),
      ...(keyPoints.length ? ["KEY POINTS", ...keyPoints.map((k) => `- ${k}`), ""] : []),
      ...(insights.length ? ["INSIGHTS", "", ...sectionLines(insights)] : []),
      ...(actionItems.length
        ? ["ACTION ITEMS", ...actionItems.map((a) => `- [ ] ${a}`), ""]
        : []),
      ...(outline.length ? ["OUTLINE", "", ...sectionLines(outline)] : []),
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
        {tab === "Notes" ? (
          <div className="space-y-7">
            {!hasNotes && (
              <p className="text-[13.5px] text-muted">
                No notes were generated for this recording — check the Transcript tab for the
                raw transcription.
              </p>
            )}

            {/* Overview (plus any other free-form sections the backend sent) */}
            {overview.map((s, i) => (
              <Block key={`ov-${i}`} icon={<IconNotes className="h-4 w-4" />} title={s.heading}>
                {s.body && <p className="text-[#cfd3f0]">{s.body}</p>}
                {s.bullets && <Bullets items={s.bullets} />}
              </Block>
            ))}

            {keyPoints.length > 0 && (
              <Block icon={<IconSparkle className="h-4 w-4" />} title="Key points">
                <Bullets items={keyPoints} />
              </Block>
            )}

            {insights.length > 0 && (
              <Block icon={<IconSparkle className="h-4 w-4" />} title="Insights">
                <div className="space-y-4">
                  {insights.map((s, i) => (
                    <div key={i}>
                      <h5 className="text-[13.5px] font-semibold text-[#e6e9ff] mb-1">
                        {s.heading}
                      </h5>
                      {s.body && <p className="text-[#cfd3f0]">{s.body}</p>}
                      {s.bullets && <Bullets items={s.bullets} />}
                    </div>
                  ))}
                </div>
              </Block>
            )}

            {actionItems.length > 0 && (
              <Block icon={<IconCheckSquare className="h-4 w-4" />} title="Action items">
                <ul className="space-y-2.5">
                  {actionItems.map((a, i) => (
                    <li key={i}>
                      <label className="flex cursor-pointer items-start gap-3 text-[14px]">
                        <input
                          type="checkbox"
                          checked={!!checked[i]}
                          onChange={() => setChecked((c) => ({ ...c, [i]: !c[i] }))}
                          className="mt-1.5 h-4 w-4 shrink-0 cursor-pointer accent-neon"
                        />
                        <span
                          className={
                            checked[i] ? "text-muted line-through" : "text-[#d3d7f5]"
                          }
                        >
                          {a}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </Block>
            )}

            {outline.length > 0 && (
              <Block icon={<IconList className="h-4 w-4" />} title="Outline">
                <div className="space-y-5">
                  {outline.map((s, i) => (
                    <div key={i} className="border-l-2 border-neon/25 pl-4">
                      <h5 className="text-[13.5px] font-semibold text-[#e6e9ff] mb-1">
                        {s.heading}
                      </h5>
                      {s.body && <p className="text-[#cfd3f0]">{s.body}</p>}
                      {s.bullets && <Bullets items={s.bullets} />}
                    </div>
                  ))}
                </div>
              </Block>
            )}

            {rec.tags.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-1">
                {rec.tags.map((t) => (
                  <span
                    key={t}
                    className="text-[12px] px-2.5 py-1 rounded-full bg-neon2/10 text-neon2 border border-neon2/20"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          <TranscriptView
            rec={rec}
            audioRef={audioRef}
            onSpeakersChange={(speakers) => onRecChange?.({ ...rec, speakers })}
          />
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

function Block({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h4 className="mb-2.5 flex items-center gap-2 text-[12px] uppercase tracking-[0.08em] text-neon2">
        {icon}
        {title}
      </h4>
      {children}
    </section>
  );
}

function Bullets({ items }: { items: string[] }) {
  return (
    <ul className="list-disc ml-5 text-[#d3d7f5] space-y-2">
      {items.map((b, i) => (
        <li key={i}>{b}</li>
      ))}
    </ul>
  );
}
