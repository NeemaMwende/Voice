"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useApp } from "@/context/AppContext";
import { fmtDuration } from "@/lib/notes";
import PageHeader from "@/components/PageHeader";
import NotesViewer from "@/components/NotesViewer";
import { IconNotes, IconUpload } from "@/components/icons";

export default function NotesPage() {
  const { recordings, loading } = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const deepLinked = useRef(false);

  // Open a specific recording's notes when linked as /notes?id=<id>.
  useEffect(() => {
    if (deepLinked.current) return;
    deepLinked.current = true;
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) setSelected(id);
  }, []);

  // Fall back to the newest recording when nothing valid is selected. The
  // functional update matters: on a deep link both effects run in the same
  // commit, and this must see the id the effect above just queued.
  useEffect(() => {
    if (!recordings.length) return;
    setSelected((cur) =>
      cur && recordings.some((r) => r.id === cur) ? cur : recordings[0].id
    );
  }, [recordings]);

  const active = recordings.find((r) => r.id === selected) ?? null;

  if (loading) {
    return (
      <div>
        <PageHeader title="Notes" subtitle="Every set of generated notes, in one place." />
        <div className="rounded-3xl border border-white/[0.08] bg-panel backdrop-blur-xl shadow-card p-14 text-center text-[13.5px] text-muted">
          Loading your notes…
        </div>
      </div>
    );
  }

  if (recordings.length === 0) {
    return (
      <div>
        <PageHeader title="Notes" subtitle="Every set of generated notes, in one place." />
        <div className="rounded-3xl border border-white/[0.08] bg-panel backdrop-blur-xl shadow-card p-14 text-center">
          <IconNotes className="w-14 h-14 mx-auto opacity-30 mb-4 text-muted" />
          <p className="text-[13.5px] text-muted mb-5">No notes yet.</p>
          <Link
            href="/upload"
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-br from-neon to-neon2 px-5 py-2.5 text-sm font-semibold text-white"
          >
            <IconUpload className="w-4 h-4" /> Generate your first notes
          </Link>
        </div>
      </div>
    );
  }

  // h-, not just min-h-, on large screens: the notes panel scrolls internally
  // via `flex-1 min-h-0 overflow-auto`, and that only works if an ancestor has
  // a definite height. With min-h alone the card just grows and the whole page
  // scrolls instead. Small screens keep the natural flow.
  return (
    <div className="flex flex-col min-h-[calc(100vh-4rem)] lg:h-[calc(100vh-4rem)]">
      <PageHeader title="Notes" subtitle="Every set of generated notes, in one place." />

      <div className="grid flex-1 min-h-0 grid-cols-1 items-stretch gap-6 lg:grid-cols-[300px_1fr]">
        {/* list — scrolls on its own so a long library can't push the page */}
        <div className="space-y-2.5 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
          {recordings.map((r) => (
            <button
              key={r.id}
              onClick={() => setSelected(r.id)}
              className={`w-full text-left rounded-2xl border p-4 transition-all ${
                selected === r.id
                  ? "border-neon/60 bg-neon/10"
                  : "border-white/[0.07] bg-panel hover:bg-white/[0.05]"
              }`}
            >
              <div className="text-[13.5px] font-semibold truncate">{r.title}</div>
              <div className="text-[11px] text-muted truncate mt-0.5">
                {new Date(r.createdAt).toLocaleDateString()} · {fmtDuration(r.durationSec)}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {r.tags.slice(0, 2).map((t) => (
                  <span key={t} className="text-[10px] px-2 py-0.5 rounded-full bg-neon2/10 text-neon2 border border-neon2/20">
                    {t}
                  </span>
                ))}
              </div>
            </button>
          ))}
        </div>

        {/* viewer */}
        <div className="flex min-h-0 flex-col rounded-3xl border border-white/[0.08] bg-panel backdrop-blur-xl shadow-card p-7">
          {active && (
            <>
              <div className="mb-5 shrink-0">
                <h2 className="text-[17px] font-bold">{active.title}</h2>
                <p className="text-[12px] text-muted mt-0.5">{active.fileName}</p>
              </div>
              {active.audioUrl && <audio src={active.audioUrl} controls className="mb-5 w-full rounded-xl shrink-0" />}
              <div className="min-h-0 flex-1">
                <NotesViewer key={active.id} rec={active} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
