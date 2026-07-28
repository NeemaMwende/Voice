"use client";

import { useRef, useEffect } from "react";

export type LiveSegmentData = {
  id: string;
  speakerId: string;
  speakerName: string;
  speakerColor: string;
  text: string;
  tSec: number;
  isFinal: boolean;
};

const SPEAKER_AVATARS = ["👤", "🎤", "🗣️", "👥"];

export default function LiveTranscript({
  segments,
}: {
  segments: LiveSegmentData[];
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [segments.length]);

  if (segments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted text-sm gap-2">
        <span className="text-3xl">🎙️</span>
        <span>Listening...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4 overflow-y-auto h-full">
      {segments.map((seg) => (
        <div
          key={seg.id}
          className={`flex gap-3 items-start transition-opacity ${
            seg.isFinal ? "opacity-100" : "opacity-70"
          }`}
        >
          {/* speaker avatar */}
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0"
            style={{ backgroundColor: seg.speakerColor + "30" }}
          >
            <span>{SPEAKER_AVATARS[Number(seg.speakerId.slice(-1)) % SPEAKER_AVATARS.length]}</span>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <span
                className="text-xs font-semibold"
                style={{ color: seg.speakerColor }}
              >
                {seg.speakerName}
              </span>
              <span className="text-[10px] text-muted">
                {formatTime(seg.tSec)}
              </span>
            </div>
            <p className="text-sm leading-relaxed text-white/85">
              {seg.text}
              {!seg.isFinal && <span className="inline-block w-1.5 h-4 bg-neon2 ml-0.5 animate-pulse align-text-bottom" />}
            </p>
          </div>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
