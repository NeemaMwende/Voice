"use client";

import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import { Recording } from "@/context/AppContext";
import { fmtDuration, initials, Speaker } from "@/lib/notes";
import { IconUsers } from "./icons";

const SPEAKER_COLORS = ["#7c5cff", "#00e5ff", "#ff4ecd", "#2ee6a6", "#ffb454"];

export default function TranscriptView({
  rec,
  audioRef,
  onSpeakersChange,
}: {
  rec: Recording;
  audioRef?: React.RefObject<HTMLAudioElement | null>;
  onSpeakersChange?: (speakers: Speaker[]) => void;
}) {
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
      {/* speaker count */}
      <div className="mb-4 flex items-center gap-1.5 text-[11.5px] text-muted">
        <IconUsers className="h-4 w-4" />
        {rec.speakers.length} {rec.speakers.length === 1 ? "speaker" : "speakers"}
      </div>

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

              {/* bubble */}
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
                <div
                  className={`whitespace-pre-wrap rounded-2xl rounded-tl-md border px-4 py-2.5 text-[13.5px] leading-relaxed transition-all ${
                    isActive
                      ? "border-neon2/40 bg-neon2/10 text-fg"
                      : "border-overlay/[0.06] bg-overlay/[0.03] text-fg/80"
                  }`}
                >
                  {seg.clean}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
