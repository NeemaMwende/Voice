"use client";

import { useMemo, useState } from "react";
import { Recording } from "@/context/AppContext";
import { diffRaw, fmtStamp, initials, Speaker } from "@/lib/demo";
import { IconSparkle, IconUsers } from "./icons";

type Mode = "clean" | "verbatim";

export default function TranscriptView({ rec }: { rec: Recording }) {
  const [mode, setMode] = useState<Mode>("clean");

  const speakerMap = useMemo(() => {
    const m: Record<string, Speaker> = {};
    rec.speakers?.forEach((s) => (m[s.id] = s));
    return m;
  }, [rec.speakers]);

  const removedCount = useMemo(
    () =>
      (rec.segments ?? []).reduce(
        (n, s) => n + diffRaw(s.raw, s.clean).filter((t) => t.removed && /\S/.test(t.text)).length,
        0
      ),
    [rec.segments]
  );

  // graceful fallback for any older records without diarized segments
  if (!rec.segments?.length) {
    return <p className="whitespace-pre-wrap leading-7 text-[#cfd3f0]">{rec.transcript}</p>;
  }

  return (
    <div>
      {/* toolbar: speaker count + mode toggle */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <IconUsers className="h-4 w-4" />
          {rec.speakers.length} {rec.speakers.length === 1 ? "speaker" : "speakers"}
          <span className="mx-1.5 opacity-40">·</span>
          {mode === "verbatim" ? (
            <span className="text-neon3">{removedCount} noise words highlighted</span>
          ) : (
            <span className="text-ok">{removedCount} noise words removed</span>
          )}
        </div>

        <div className="flex rounded-full bg-white/[0.05] p-1 text-[11px] font-semibold">
          {(["clean", "verbatim"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-all ${
                mode === m ? "bg-gradient-to-br from-neon to-neon2 text-white shadow-[0_4px_14px_-4px_#7c5cff]" : "text-muted hover:text-white"
              }`}
            >
              {m === "clean" ? (
                <>
                  <IconSparkle className="h-3.5 w-3.5" /> Cleaned
                </>
              ) : (
                "Verbatim"
              )}
            </button>
          ))}
        </div>
      </div>

      {/* speaker turns */}
      <div className="space-y-4">
        {rec.segments.map((seg, i) => {
          const sp = speakerMap[seg.speakerId] ?? { id: seg.speakerId, name: "Speaker", color: "#7c5cff" };
          return (
            <div key={i} className="flex gap-3">
              {/* avatar */}
              <div className="flex flex-col items-center pt-0.5">
                <div
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[12px] font-bold text-white"
                  style={{ background: `linear-gradient(135deg, ${sp.color}, ${sp.color}99)`, boxShadow: `0 6px 16px -6px ${sp.color}` }}
                >
                  {initials(sp.name)}
                </div>
                {i < rec.segments.length - 1 && <span className="mt-1 w-px flex-1 bg-white/10" />}
              </div>

              {/* bubble */}
              <div className="min-w-0 flex-1 pb-1">
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold" style={{ color: sp.color }}>
                    {sp.name}
                  </span>
                  <span className="font-mono text-[10.5px] text-muted">{fmtStamp(seg.tSec)}</span>
                </div>
                <div
                  className="rounded-2xl rounded-tl-md border border-white/[0.06] bg-white/[0.03] px-4 py-2.5 text-[13.5px] leading-relaxed text-[#dfe2fb]"
                >
                  {mode === "clean" ? seg.clean : <Verbatim raw={seg.raw} clean={seg.clean} />}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {mode === "verbatim" && (
        <div className="mt-4 flex items-center gap-2 text-[11px] text-muted">
          <span className="inline-block rounded bg-neon3/15 px-1.5 py-0.5 text-neon3 line-through decoration-neon3/70">removed</span>
          fillers, stutters &amp; background noise stripped in the cleaned view
        </div>
      )}
    </div>
  );
}

function Verbatim({ raw, clean }: { raw: string; clean: string }) {
  const tokens = useMemo(() => diffRaw(raw, clean), [raw, clean]);
  return (
    <span>
      {tokens.map((t, i) =>
        t.removed && /\S/.test(t.text) ? (
          <span key={i} className="rounded bg-neon3/10 text-neon3/80 line-through decoration-neon3/60">
            {t.text}
          </span>
        ) : (
          <span key={i}>{t.text}</span>
        )
      )}
    </span>
  );
}
