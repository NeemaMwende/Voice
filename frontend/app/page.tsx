"use client";

import Link from "next/link";
import { useApp } from "@/context/AppContext";
import { fmtDuration } from "@/lib/notes";
import PageHeader from "@/components/PageHeader";
import { IconWave, IconClock, IconNotes, IconUpload, IconPlay } from "@/components/icons";

export default function OverviewPage() {
  const { recordings } = useApp();

  const totalSec = recordings.reduce((a, r) => a + r.durationSec, 0);
  const totalNotes = recordings.reduce((a, r) => a + r.summary.length + r.key.length, 0);

  const stats = [
    { label: "Recordings", value: recordings.length, Icon: IconWave, tint: "from-neon to-neon2" },
    { label: "Minutes transcribed", value: Math.round(totalSec / 60), Icon: IconClock, tint: "from-neon2 to-ok" },
    { label: "Notes generated", value: totalNotes, Icon: IconNotes, tint: "from-neon3 to-neon" },
  ];

  return (
    <div>
      <PageHeader title="Overview" subtitle="Your transcription workspace at a glance." />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5 mb-8">
        {stats.map(({ label, value, Icon, tint }) => (
          <div key={label} className="rounded-3xl border border-white/[0.08] bg-panel backdrop-blur-xl shadow-card p-6">
            <div className={`mb-4 grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br ${tint} text-white`}>
              <Icon className="w-5 h-5" />
            </div>
            <div className="text-3xl font-bold">{value}</div>
            <div className="text-[12.5px] text-muted mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_0.8fr] gap-6">
        <div className="rounded-3xl border border-white/[0.08] bg-panel backdrop-blur-xl shadow-card p-7">
          <div className="flex items-center justify-between mb-5">
            <h2 className="text-[15px] font-semibold">Recent activity</h2>
            <Link href="/recordings" className="text-xs text-neon2 hover:underline">
              View all
            </Link>
          </div>
          {recordings.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="space-y-3">
              {recordings.slice(0, 5).map((r) => (
                <Link
                  key={r.id}
                  href={`/notes?id=${r.id}`}
                  className="group flex items-center gap-4 rounded-2xl border border-white/[0.07] bg-white/[0.03] p-3.5 transition-all hover:-translate-y-0.5 hover:border-neon/40 hover:bg-white/[0.06]"
                >
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-neon to-neon3 transition-transform group-hover:scale-105">
                    <IconPlay className="w-4 h-4 text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="truncate text-[13.5px] font-semibold transition-colors group-hover:text-neon2">
                      {r.title}
                    </div>
                    <div className="text-[11.5px] text-muted truncate">{r.fileName}</div>
                  </div>
                  <div className="text-xs text-neon2 shrink-0">{fmtDuration(r.durationSec)}</div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-3xl border border-white/[0.08] bg-gradient-to-br from-neon/15 to-neon2/5 backdrop-blur-xl shadow-card p-7 flex flex-col justify-between">
          <div>
            <h2 className="text-[15px] font-semibold mb-2">Ready to transcribe?</h2>
            <p className="text-[13px] text-muted leading-relaxed">
              Drop an audio file and get a clean transcript plus structured notes
              in seconds.
            </p>
          </div>
          <Link
            href="/upload"
            className="mt-6 flex items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-neon to-neon2 py-3 text-sm font-semibold text-white hover:-translate-y-0.5 transition-transform"
          >
            <IconUpload className="w-4 h-4" /> Upload audio
          </Link>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-center text-muted py-12 text-[13px]">
      <IconWave className="w-12 h-12 mx-auto opacity-30 mb-3" />
      No recordings yet. Head to Upload &amp; Transcribe to add your first one.
    </div>
  );
}
