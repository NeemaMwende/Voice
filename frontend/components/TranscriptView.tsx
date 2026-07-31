"use client";

import { ReactNode, useMemo, useState } from "react";
import { Recording } from "@/context/AppContext";
import { diffRaw, fmtStamp, initials, Segment, SentenceSpan, Speaker } from "@/lib/notes";
import { IconSparkle, IconUsers } from "./icons";

/**
 * Views of the same conversation, and nothing is ever thrown away:
 *
 *   Verbatim  exactly as spoken — every word, no markup at all
 *   Cleaned   what cleaning removed, struck through in place: filler words in
 *             pink, set-aside sentences in amber. The toggle hides them,
 *             leaving the clean business read-through.
 *   Business  NOT a transcript: the business record the model wrote from the
 *             cleaned text, in prose. This is the SOP's source text.
 *   Compare   verbatim and cleaned side by side
 */
type Mode = "compare" | "verbatim" | "clean" | "business";

const MODES: { id: Mode; label: string }[] = [
  { id: "compare", label: "Compare" },
  { id: "verbatim", label: "Verbatim" },
  { id: "clean", label: "Cleaned" },
  { id: "business", label: "Business only" },
];

const isSmallTalk = (s: SentenceSpan) => s.label === "smalltalk";

/**
 * Business text for a turn — what the Cleaned view reads through. Falls back
 * through the tiers so records made before the relevance pass still render.
 */
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

export default function TranscriptView({ rec }: { rec: Recording }) {
  const [mode, setMode] = useState<Mode>("compare");
  const [hideRemoved, setHideRemoved] = useState(false);

  const speakerMap = useMemo(() => {
    const m: Record<string, Speaker> = {};
    rec.speakers?.forEach((s) => (m[s.id] = s));
    return m;
  }, [rec.speakers]);

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

  // graceful fallback for any older records without diarized segments
  if (!rec.segments?.length) {
    return <p className="whitespace-pre-wrap leading-7 text-[#cfd3f0]">{rec.transcript}</p>;
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

      {mode === "clean" && (
        <label className="mb-3 flex cursor-pointer items-center gap-2 text-[11.5px] text-muted">
          <input
            type="checkbox"
            checked={hideRemoved}
            onChange={() => setHideRemoved((v) => !v)}
            className="h-3.5 w-3.5 cursor-pointer accent-neon"
          />
          Hide the crossed-out filler &amp; small talk
        </label>
      )}

      {/* column headings, compare mode only */}
      {mode === "compare" && (
        <div className="mb-2 hidden gap-3 pl-12 md:grid md:grid-cols-2">
          <ColumnHead tint="text-neon3" label="Verbatim" note="every word, as spoken" />
          <ColumnHead tint="text-ok" label="Cleaned" note="filler & small talk removed" />
        </div>
      )}

      {/* The business record replaces the turn-by-turn read entirely — it is a
          written account, so there is nothing to attribute to a speaker. */}
      {mode === "business" ? (
        <BusinessRecord text={rec.businessSummary} />
      ) : (
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
                        <VerbatimTurn seg={seg} />
                      </Bubble>
                      <Bubble accent="clean" caption="Cleaned">
                        <CleanedTurn seg={seg} hideRemoved />
                      </Bubble>
                    </div>
                  ) : (
                    <Bubble accent={mode === "verbatim" ? "verbatim" : "clean"}>
                      {mode === "verbatim" ? (
                        <VerbatimTurn seg={seg} />
                      ) : (
                        <CleanedTurn seg={seg} hideRemoved={hideRemoved} />
                      )}
                    </Bubble>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Only Cleaned marks anything up, and only while the toggle is off. */}
      {mode === "clean" && !hideRemoved && (
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

/** Verbatim: exactly as spoken. Nothing marked, nothing struck, nothing hidden. */
function VerbatimTurn({ seg }: { seg: Segment }) {
  return <>{seg.raw}</>;
}

/**
 * Cleaned content. By default it shows what cleaning took out, struck through —
 * filler words in pink, whole set-aside sentences in amber — so you can see
 * exactly what was removed and why. Tick the toggle and those disappear,
 * leaving the clean business read-through.
 */
function CleanedTurn({ seg, hideRemoved }: { seg: Segment; hideRemoved: boolean }) {
  if (hideRemoved) {
    const business = businessText(seg);
    return <>{business || <Empty>Nothing left after cleaning.</Empty>}</>;
  }

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
 * The business record — not a transcript. The model reads the cleaned text and
 * writes out the process, steps, rules, figures and decisions in prose; the SOP
 * is generated from this. Absent on recordings made before it existed, and on
 * any where the summarizer was unreachable.
 */
function BusinessRecord({ text }: { text?: string }) {
  const paragraphs = useMemo(
    () =>
      (text ?? "")
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean),
    [text]
  );

  return (
    <div className="rounded-2xl border border-ok/20 bg-ok/[0.04] px-5 py-4">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ok">
        <IconSparkle className="h-3.5 w-3.5" />
        Business record
      </div>
      <p className="mb-3 text-[11.5px] text-muted">
        Written by the model from the cleaned transcript — the source text for the SOP.
      </p>
      {paragraphs.length ? (
        <div className="space-y-3 text-[13.5px] leading-relaxed text-[#dfe2fb]">
          {paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      ) : (
        <Empty>
          No business record for this recording — it was transcribed before this
          existed, the summarizer was unreachable, or the conversation carried no
          business content. Switch to Cleaned to read the transcript itself.
        </Empty>
      )}
    </div>
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
