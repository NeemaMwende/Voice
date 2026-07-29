"use client";

import { ReactNode, useMemo, useState } from "react";
import { Recording } from "@/context/AppContext";
import { diffRaw, fmtStamp, initials, Speaker } from "@/lib/notes";
import { IconSparkle, IconUsers } from "./icons";

/**
 * "compare" shows both versions of every turn side by side — the verbatim
 * record with its noise struck through, and the cleaned text beside it — so
 * you can see exactly what was removed. The single-column modes are for
 * reading one version end to end.
 */
type Mode = "compare" | "clean" | "verbatim";

const MODES: { id: Mode; label: string }[] = [
  { id: "compare", label: "Compare" },
  { id: "clean", label: "Cleaned" },
  { id: "verbatim", label: "Verbatim" },
];

export default function TranscriptView({ rec }: { rec: Recording }) {
  const [mode, setMode] = useState<Mode>("compare");

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
      {/* toolbar: speaker count + mode switch */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-[11.5px] text-muted">
          <IconUsers className="h-4 w-4" />
          {rec.speakers.length} {rec.speakers.length === 1 ? "speaker" : "speakers"}
          <span className="mx-1.5 opacity-40">·</span>
          <span className={mode === "clean" ? "text-ok" : "text-neon3"}>
            {removedCount} noise {removedCount === 1 ? "word" : "words"}{" "}
            {mode === "clean" ? "removed" : "highlighted"}
          </span>
        </div>

        <div className="flex rounded-full bg-white/[0.05] p-1 text-[11px] font-semibold">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setMode(m.id)}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 transition-all ${
                mode === m.id
                  ? "bg-gradient-to-br from-neon to-neon2 text-white shadow-[0_4px_14px_-4px_#7c5cff]"
                  : "text-muted hover:text-white"
              }`}
            >
              {m.id === "clean" && <IconSparkle className="h-3.5 w-3.5" />}
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* column headings, compare mode only */}
      {mode === "compare" && (
        <div className="mb-2 hidden gap-3 pl-12 md:grid md:grid-cols-2">
          <ColumnHead tint="text-neon3" label="Verbatim" note="everything, as spoken" />
          <ColumnHead tint="text-ok" label="Cleaned" note="fillers & noise removed" />
        </div>
      )}

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

              {/* bubble(s) */}
              <div className="min-w-0 flex-1 pb-1">
                <div className="mb-1 flex items-baseline gap-2">
                  <span className="text-[13px] font-semibold" style={{ color: sp.color }}>
                    {sp.name}
                  </span>
                  <span className="font-mono text-[10.5px] text-muted">{fmtStamp(seg.tSec)}</span>
                </div>

                {mode === "compare" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <Bubble accent="verbatim" caption="Verbatim">
                      <Verbatim raw={seg.raw} clean={seg.clean} />
                    </Bubble>
                    <Bubble accent="clean" caption="Cleaned">
                      {seg.clean.trim() ? (
                        seg.clean
                      ) : (
                        <span className="italic text-muted">Filler only — nothing left after cleaning.</span>
                      )}
                    </Bubble>
                  </div>
                ) : (
                  <Bubble accent={mode === "clean" ? "clean" : "verbatim"}>
                    {mode === "clean" ? (
                      seg.clean.trim() || (
                        <span className="italic text-muted">Filler only — nothing left after cleaning.</span>
                      )
                    ) : (
                      <Verbatim raw={seg.raw} clean={seg.clean} />
                    )}
                  </Bubble>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {mode !== "clean" && (
        <div className="mt-4 flex items-center gap-2 text-[11px] text-muted">
          <span className="inline-block rounded bg-neon3/15 px-1.5 py-0.5 text-neon3 line-through decoration-neon3/70">
            removed
          </span>
          fillers, stutters &amp; background noise stripped from the cleaned version
        </div>
      )}
    </div>
  );
}

function ColumnHead({ tint, label, note }: { tint: string; label: string; note: string }) {
  return (
    <div className="text-[10.5px] uppercase tracking-[0.1em]">
      <span className={`font-semibold ${tint}`}>{label}</span>
      <span className="ml-2 normal-case tracking-normal text-muted">{note}</span>
    </div>
  );
}

function Bubble({
  accent,
  caption,
  children,
}: {
  accent: "clean" | "verbatim";
  caption?: string;
  children: ReactNode;
}) {
  const tone =
    accent === "clean"
      ? "border-ok/20 bg-ok/[0.04]"
      : "border-neon3/20 bg-neon3/[0.04]";
  return (
    <div
      className={`whitespace-pre-wrap rounded-2xl rounded-tl-md border px-4 py-2.5 text-[13.5px] leading-relaxed text-[#dfe2fb] ${tone}`}
    >
      {caption && (
        <div
          className={`mb-1.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] md:hidden ${
            accent === "clean" ? "text-ok" : "text-neon3"
          }`}
        >
          {caption}
        </div>
      )}
      {children}
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
