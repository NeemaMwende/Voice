"use client";

import { useState, useEffect, ReactNode } from "react";
import { usePathname } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import { IconMic, IconMenu, IconX } from "@/components/icons";

// Routes that render full-screen without the app nav chrome (auth pages).
// /login is a real sign-in door again — both auth pages share the chamber.
const BARE_ROUTES = ["/signup", "/login"];

export default function Shell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close drawer on route change — prevents it staying open over the new page
  useEffect(() => setOpen(false), [pathname]);

  // Auth pages get no sidebar/top bar — just the centered content.
  if (BARE_ROUTES.some((r) => pathname === r || pathname.startsWith(r + "/"))) {
    return <div className="relative z-10 min-h-screen">{children}</div>;
  }

  return (
    <div className="relative z-10 flex min-h-screen">
      {/* ── Mobile top bar (hidden on lg+) ── */}
      <header className="fixed top-0 left-0 right-0 z-50 flex items-center gap-3 border-b border-overlay/[0.07] bg-bar/90 backdrop-blur-xl px-4 py-3 lg:hidden">
        <button
          onClick={() => setOpen((v) => !v)}
          className="grid h-9 w-9 place-items-center rounded-xl text-fg hover:bg-overlay/[0.08] transition-colors"
          aria-label={open ? "Close menu" : "Open menu"}
        >
          {open ? <IconX className="w-5 h-5" /> : <IconMenu className="w-5 h-5" />}
        </button>
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl grid place-items-center bg-gradient-to-br from-neon to-neon2 shadow-[0_0_16px_rgba(124,92,255,0.5)]">
            <IconMic className="w-4 h-4 text-white" />
          </div>
          <span className="text-sm font-bold tracking-tight">DAXA</span>
        </div>
      </header>

      {/* ── Backdrop overlay (mobile only) ── */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* ── Sidebar (drawer on mobile, sticky on desktop) ── */}
      <Sidebar open={open} onClose={() => setOpen(false)} />

      {/* ── Main content area ── */}
      <main className="flex-1 min-w-0 min-h-screen pt-14 lg:pt-0">
        <div className="mx-auto w-full max-w-[1360px] px-4 sm:px-6 lg:px-8 py-8">
          {children}
        </div>
      </main>
    </div>
  );
}
