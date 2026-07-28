"use client";

import { useState } from "react";
import Link from "next/link";
import { useApp } from "@/context/AppContext";
import { fmtDuration, fmtSize } from "@/lib/notes";
import PageHeader from "@/components/PageHeader";
import { IconPlay, IconSearch, IconTrash, IconWave, IconUpload } from "@/components/icons";

export default function RecordingsPage() {
  const { recordings, removeRecording } = useApp();
  const [q, setQ] = useState("");
  const [playing, setPlaying] = useState<string | null>(null);

  const filtered = recordings.filter(
    (r) =>
      r.title.toLowerCase().includes(q.toLowerCase()) ||
      r.fileName.toLowerCase().includes(q.toLowerCase()) ||
      r.tags.some((t) => t.toLowerCase().includes(q.toLowerCase()))
  );

  return (
    <div>
      <PageHeader title="Recordings" subtitle="Your library of transcribed audio." />

      <div className="relative mb-6 max-w-md">
        <IconSearch className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search recordings, files or tags…"
          className="w-full rounded-xl border border-white/[0.08] bg-white/[0.04] py-3 pl-10 pr-4 text-sm placeholder:text-muted focus:border-neon2 focus:outline-none"
        />
      </div>

      {recordings.length === 0 ? (
        <div className="rounded-3xl border border-white/[0.08] bg-panel backdrop-blur-xl shadow-card p-14 text-center">
          <IconWave className="w-14 h-14 mx-auto opacity-30 mb-4 text-muted" />
          <p className="text-[13.5px] text-muted mb-5">No recordings yet.</p>
          <Link
            href="/upload"
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-neon to-neon2 px-5 py-2.5 text-sm font-semibold text-white"
          >
            <IconUpload className="w-4 h-4" /> Upload your first file
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((r) => (
            <div
              key={r.id}
              className="rounded-2xl border border-white/[0.08] bg-panel backdrop-blur-xl shadow-card p-4"
            >
              <div className="flex items-center gap-4">
                <button
                  onClick={() => setPlaying(playing === r.id ? null : r.id)}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-neon to-neon3 hover:scale-105 transition-transform"
                >
                  <IconPlay className="w-4 h-4 text-white" />
                </button>
                <div className="flex-1 min-w-0">
                  <div className="truncate text-sm font-semibold">{r.title}</div>
                  <div className="text-[11.5px] text-muted truncate">
                    {r.fileName} · {new Date(r.createdAt).toLocaleString()} · {fmtSize(r.sizeBytes)}
                  </div>
                </div>
                <div className="hidden sm:flex flex-wrap gap-1.5 justify-end max-w-[220px]">
                  {r.tags.map((t) => (
                    <span key={t} className="text-[10.5px] px-2 py-0.5 rounded-full bg-neon2/10 text-neon2 border border-neon2/20">
                      {t}
                    </span>
                  ))}
                </div>
                <div className="text-xs text-neon2 shrink-0 w-12 text-right">{fmtDuration(r.durationSec)}</div>
                <Link href="/notes" className="text-[11px] text-muted hover:text-white shrink-0">
                  Notes →
                </Link>
                <button
                  onClick={() => removeRecording(r.id)}
                  className="text-muted hover:text-neon3 shrink-0"
                  aria-label="Delete"
                >
                  <IconTrash className="w-4 h-4" />
                </button>
              </div>
              {playing === r.id && r.audioUrl && (
                <audio src={r.audioUrl} controls autoPlay className="mt-3 w-full rounded-xl" />
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="text-center text-muted py-10 text-sm">No matches for “{q}”.</div>
          )}
        </div>
      )}
    </div>
  );
}
