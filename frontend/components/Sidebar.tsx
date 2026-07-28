"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { IconGrid, IconUpload, IconWave, IconNotes, IconMic } from "./icons";
import { useApp } from "@/context/AppContext";

const nav = [
  { href: "/", label: "Overview", Icon: IconGrid },
  { href: "/upload", label: "Capture & Transcribe", Icon: IconUpload },
  { href: "/recordings", label: "Recordings", Icon: IconWave },
  { href: "/notes", label: "Notes", Icon: IconNotes },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { recordings } = useApp();

  return (
    <aside className="w-[248px] shrink-0 border-r border-white/[0.07] bg-black/20 backdrop-blur-xl p-5 flex flex-col min-h-screen sticky top-0">
      <div className="flex items-center gap-3 mb-9 px-1">
        <div className="w-11 h-11 rounded-2xl grid place-items-center bg-gradient-to-br from-neon to-neon2 shadow-[0_0_24px_rgba(124,92,255,0.6)]">
          <IconMic className="w-6 h-6 text-white" />
        </div>
        <div>
          <div className="text-lg font-bold tracking-tight">EchoNotes</div>
          <div className="text-[10px] text-muted tracking-[0.15em]">AUDIO → NOTES</div>
        </div>
      </div>

      <nav className="flex flex-col gap-1.5">
        {nav.map(({ href, label, Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 px-3.5 py-3 rounded-xl text-sm font-medium transition-all ${
                active
                  ? "bg-gradient-to-r from-neon/90 to-neon2/80 text-white shadow-[0_8px_24px_-8px_rgba(124,92,255,0.8)]"
                  : "text-muted hover:text-white hover:bg-white/[0.05]"
              }`}
            >
              <Icon className="w-[18px] h-[18px]" />
              <span>{label}</span>
              {href === "/recordings" && recordings.length > 0 && (
                <span className="ml-auto text-[11px] px-2 py-0.5 rounded-full bg-white/15">
                  {recordings.length}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto pt-6">
        <div className="rounded-2xl border border-white/[0.08] p-4 bg-white/[0.03]">
          <div className="text-xs font-semibold text-neon2 mb-1">Live pipeline</div>
          <p className="text-[11px] text-muted leading-relaxed">
            Upload or record, then Whisper transcribes and pyannote splits it by
            speaker. Start the backend on port 8000.
          </p>
        </div>
      </div>
    </aside>
  );
}
