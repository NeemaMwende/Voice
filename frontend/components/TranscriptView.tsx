"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ReactNode } from "react";
import { Recording } from "@/context/AppContext";
import { diffRaw, fmtDuration, initials, Segment, SentenceSpan, Speaker } from "@/lib/notes";
import { IconSparkle, IconUsers } from "./icons";

const SPEAKER_COLORS = ["#7c5cff", "#00e5ff", "#ff4ecd", "#2ee6a6", "#ffb454"];

/**
 * Three tiers of the same conversation, and nothing is ever thrown away:
 *
 *   Verbatim  every word, with fillers struck in pink and off-topic
 *             sentences struck in amber
 *   Cleaned   fillers gone, every topic still present
 *   Business  the business discussion — what an SOP would be written from.
 *             Set-aside sentences stay visible in place, struck through, so
 *             you can always see what was excluded (toggle to hide them).
 *   Compare   verbatim and business side by side
 */
type Mode = "compare" | "verbatim" | "clean" | "business";

const MODES: { id: Mode; label: string }[] = [
  { id: "compare", label: "Compare" },
  { id: "verbatim", label: "Verbatim" },
  { id: "clean", label: "Cleaned" },
  { id: "business", label: "Business only" },
];

const isSmallTalk = (s: SentenceSpan) => s.label === "smalltalk";

/** Business text for a turn, falling back through the tiers for old records. */
function businessText(seg: Segment): string {
  if (seg.relevant !== undefined) return seg.relevant.trim();
  if (seg.sentences?.length) {
    return seg.sentences
      .filter((s) => !isSmallTalk(s))
      .map((s) => s.clean.trim())
      .filter(Boolean)
      .join(" ");
  }
  return seg.clean.trim();
}

export default function TranscriptView({
  rec,
  audioRef,
  onSpeakersChange,
}: {
  rec: Recording;
  audioRef?: React.RefObject<HTMLAudioElement | null>;
  onSpeakersChange?: (speakers: Speaker[]) => void;
}) {
  const [mode, setMode] = useState<Mode>("compare");
  const [hideRemoved, setHideRemoved] = useState(false);

  const speakerMap = useMemo(() => {
    const m: Record<string, Speaker> = {};
    rec.speakers?.forEach((s) => (m[s.id] = s));
    return m;
  }, [rec.speakers]);

  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const [userScrolled, setUserScrolled] = useState(false);
  const userScrollTimer = useRef<ReturnType<typeof setTimeout>>();

  // Click-to-seek: jump audio playback to a segment's start time
  const handleSeek = useCallback(
    (tSec: number) => {
      if (audioRef?.current) {
        audioRef.current.currentTime = tSec;
        audioRef.current.play();
      }
    },
    [audioRef]
  );

  // Two independent tallies: words lost to fillers, sentences set aside as
  // off-topic. Counting fillers per sentence rather than per turn also keeps
  // the (quadratic) diff cheap on long recordings.
  const stats = useMemo(() => {
    let fillerWords = 0;
    let smallTalk = 0;
    for (const seg of rec.segments ?? []) {
      if (seg.sentences?.length) {
        for (const s of seg.sentences) {
          if (isSmallTalk(s)) smallTalk++;
          else fillerWords += diffRaw(s.raw, s.clean).filter((t) => t.removed && /\S/.test(t.text)).length;
        }
      } else {
        fillerWords += diffRaw(seg.raw, seg.clean).filter((t) => t.removed && /\S/.test(t.text)).length;
      }
    }
    return { fillerWords, smallTalk };
  }, [rec.segments]);

  // Playback highlight: listen to timeupdate events and find the active segment
  useEffect(() => {
    const audio = audioRef?.current;
    if (!audio) return;
    const onTimeUpdate = () => {
      const current = audio.currentTime;
      const idx = rec.segments.findIndex((seg, i) => {
        const end = seg.endSec ?? rec.segments[i + 1]?.tSec ?? Infinity;
        return seg.tSec <= current && current < end;
      });
      setActiveIndex(idx);
    };
    audio.addEventListener("timeupdate", onTimeUpdate);
    return () => audio.removeEventListener("timeupdate", onTimeUpdate);
  }, [audioRef, rec.segments]);

  // Auto-scroll to active segment, suppressed for 3s after manual scroll
  const containerRef = useRef<HTMLDivElement>(null);
  const handleManualScroll = useCallback(() => {
    setUserScrolled(true);
    clearTimeout(userScrollTimer.current);
    userScrollTimer.current = setTimeout(() => setUserScrolled(false), 3000);
  }, []);

  useEffect(() => {
    if (activeIndex >= 0 && !userScrolled) {
      document.getElementById(`seg-${activeIndex}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeIndex, userScrolled]);

  // graceful fallback for any older records without diarized segments
  if (!rec.segments?.length) {
    return <p className="whitespace-pre-wrap leading-7 text-fg/80">{rec.transcript}</p>;
  }

  return (
    <div>
      {/* toolbar */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-muted">
          <IconUsers className="h-4 w-4" />
          {rec.speakers.length} {rec.speakers.length === 1 ? "speaker" : "speakers"}
          <span className="mx-1 opacity-40">·</span>
          <span className="text-neon3">{stats.fillerWords} filler words</span>
          <span className="mx-1 opacity-40">·</span>
          <span className="text-warn">
            {stats.smallTalk} off-topic {stats.smallTalk === 1 ? "sentence" : "sentences"}
          </span>
        </div>

        <div className="flex flex-wrap rounded-full bg-white/[0.05] p-1 text-[11px] font-semibold">
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
              {m.id === "business" && <IconSparkle className="h-3.5 w-3.5" />}
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {mode === "business" && (
        <label className="mb-3 flex cursor-pointer items-center gap-2 text-[11.5px] text-muted">
          <input
            type="checkbox"
            checked={hideRemoved}
            onChange={() => setHideRemoved((v) => !v)}
            className="h-3.5 w-3.5 cursor-pointer accent-neon"
          />
          Hide the set-aside sentences
        </label>
      )}

      {/* column headings, compare mode only */}
      {mode === "compare" && (
        <div className="mb-2 hidden gap-3 pl-12 md:grid md:grid-cols-2">
          <ColumnHead tint="text-neon3" label="Verbatim" note="everything, as spoken" />
          <ColumnHead tint="text-ok" label="Business only" note="small talk & noise removed" />
        </div>
      )}

      {/* speaker turns */}
      <div ref={containerRef} className="space-y-4" onWheel={handleManualScroll} onTouchMove={handleManualScroll}>
        {rec.segments.map((seg, i) => {
          const sp = speakerMap[seg.speakerId] ?? { id: seg.speakerId, name: "Speaker", color: "#7c5cff" };
          const isActive = activeIndex === i;
          return (
            <div
              key={i}
              id={`seg-${i}`}
              onClick={() => handleSeek(seg.tSec)}
              className={`flex gap-3 cursor-pointer transition-all ${isActive ? "bg-neon2/5 -mx-3 px-3 rounded-2xl" : ""}`}
            >
              {/* avatar — click to cycle color */}
              <div className="flex flex-col items-center pt-0.5">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!onSpeakersChange) return;
                    const idx = rec.speakers.findIndex((s) => s.id === sp.id);
                    if (idx === -1) return;
                    const cur = SPEAKER_COLORS.indexOf(sp.color);
                    const next = SPEAKER_COLORS[(cur + 1) % SPEAKER_COLORS.length];
                    const updated = rec.speakers.map((s, i) =>
                      i === idx ? { ...s, color: next } : s
                    );
                    onSpeakersChange(updated);
                  }}
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-full text-[12px] font-bold text-white transition-shadow cursor-pointer hover:scale-105 ${isActive ? "shadow-[0_0_20px_-4px]" : ""}`}
                  style={{ background: `linear-gradient(135deg, ${sp.color}, ${sp.color}99)`, boxShadow: isActive ? `0 0 20px -4px ${sp.color}` : `0 6px 16px -6px ${sp.color}` }}
                  aria-label="Change speaker color"
                >
                  {initials(sp.name)}
                </button>
                {i < rec.segments.length - 1 && <span className="mt-1 w-px flex-1 bg-overlay/10" />}
              </div>

              {/* bubble(s) */}
              <div className="min-w-0 flex-1 pb-1">
                <div className="mb-1 flex items-baseline gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!onSpeakersChange) return;
                      const newName = prompt("Rename speaker:", sp.name);
                      if (newName && newName !== sp.name) {
                        const idx = rec.speakers.findIndex((s) => s.id === sp.id);
                        if (idx === -1) return;
                        const updated = rec.speakers.map((s, i) =>
                          i === idx ? { ...s, name: newName } : s
                        );
                        onSpeakersChange(updated);
                      }
                    }}
                    className="text-[13px] font-semibold hover:underline focus:outline-none"
                    style={{ color: sp.color }}
                    aria-label="Rename speaker"
                  >
                    {sp.name}
                  </button>
                  <span className="font-mono text-[10.5px] text-muted">{fmtDuration(seg.tSec)}</span>
                </div>

                {mode === "compare" ? (
                  <div className="grid gap-3 md:grid-cols-2">
                    <Bubble accent="verbatim" caption="Verbatim">
                      <VerbatimTurn seg={seg} />
                    </Bubble>
                    <Bubble accent="clean" caption="Business only">
                      <BusinessTurn seg={seg} hideRemoved />
                    </Bubble>
                  </div>
                ) : (
                  <Bubble accent={mode === "verbatim" ? "verbatim" : "clean"}>
                    {mode === "verbatim" && <VerbatimTurn seg={seg} />}
                    {mode === "clean" && (seg.clean.trim() || <Empty>Filler only — nothing left after cleaning.</Empty>)}
                    {mode === "business" && <BusinessTurn seg={seg} hideRemoved={hideRemoved} />}
                  </Bubble>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {mode !== "clean" && (
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted">
          <span className="flex items-center gap-1.5">
            <span className="rounded bg-neon3/15 px-1.5 py-0.5 text-neon3 line-through decoration-neon3/70">filler</span>
            hesitations, stutters &amp; noise
          </span>
          <span className="flex items-center gap-1.5">
            <span className="rounded bg-warn/15 px-1.5 py-0.5 text-warn line-through decoration-warn/70">off-topic</span>
            small talk — kept on record, excluded from the notes
          </span>
        </div>
      )}
    </div>
  );
}

/** Verbatim: nothing hidden. Fillers struck in pink, small talk in amber. */
function VerbatimTurn({ seg }: { seg: Segment }) {
  if (!seg.sentences?.length) return <Verbatim raw={seg.raw} clean={seg.clean} />;
  return (
    <span>
      {seg.sentences.map((s, i) =>
        isSmallTalk(s) ? (
          <span
            key={i}
            title={s.reason ? `Set aside: ${s.reason}` : "Set aside as small talk"}
            className="rounded bg-warn/10 text-warn/80 line-through decoration-warn/60"
          >
            {s.raw}
          </span>
        ) : (
          <Verbatim key={i} raw={s.raw} clean={s.clean} />
        )
      )}
    </span>
  );
}

/**
 * Business content. Set-aside sentences stay in place, struck through, unless
 * hidden — so the business read-through never silently loses context.
 */
function BusinessTurn({ seg, hideRemoved }: { seg: Segment; hideRemoved: boolean }) {
  const business = businessText(seg);

  if (!seg.sentences?.length) {
    return <>{business || <Empty>Nothing left after cleaning.</Empty>}</>;
  }
  if (hideRemoved) {
    return <>{business || <Empty>Small talk only — no business content in this turn.</Empty>}</>;
  }

  const shown = seg.sentences.filter((s) => (isSmallTalk(s) ? true : s.clean.trim()));
  if (!shown.length) return <Empty>Filler only — nothing left after cleaning.</Empty>;

  return (
    <span>
      {shown.map((s, i) =>
        isSmallTalk(s) ? (
          <span
            key={i}
            title={s.reason ? `Set aside: ${s.reason}` : "Set aside as small talk"}
            className="rounded bg-warn/10 text-warn/70 line-through decoration-warn/60"
          >
            {s.clean || s.raw}{" "}
          </span>
        ) : (
          <span key={i}>{s.clean} </span>
        )
      )}
    </span>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <span className="italic text-muted">{children}</span>;
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
  const tone = accent === "clean" ? "border-ok/20 bg-ok/[0.04]" : "border-neon3/20 bg-neon3/[0.04]";
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