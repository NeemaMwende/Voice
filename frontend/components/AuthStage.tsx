"use client";

import { forwardRef, ReactNode } from "react";
import ListeningField, { ListeningFieldHandle } from "@/components/ListeningField";

/**
 * AuthStage — the "Listening Chamber" shell for auth pages.
 *
 * Three layers, breathing as one:
 *  1. The Room  — ListeningField (chamber variant), a fullscreen living field.
 *  2. The Chrome — scanline film + drifting light band + vignette + top
 *                  light-line, all pointer-events-free, between field and UI.
 *  3. The Console — a floating HUD glass frame (center-right on desktop,
 *                  bottom sheet on mobile) plus an optional ambient text
 *                  projection on the left and a compact mobile brand chip.
 *
 * The field's imperative handle is forwarded to the page so the console can
 * "talk to" the room (breathe / converge / ripple) — the full bond.
 */
interface AuthStageProps {
  /** Ambient text projected directly in the field (desktop, left side). */
  projection?: ReactNode;
  /** The console content — framed in the floating HUD glass. */
  console: ReactNode;
  /** Optional compact brand row shown above the console on mobile. */
  mobileBrand?: ReactNode;
}

const AuthStage = forwardRef<ListeningFieldHandle, AuthStageProps>(
  function AuthStage({ projection, console: consoleNode, mobileBrand }, ref) {
    return (
      <div className="relative min-h-screen">
        {/* Layer 1 — the room. */}
        <ListeningField ref={ref} variant="chamber" />

        {/* Layer 2 — chamber chrome (above the field, below the UI). */}
        <div className="pointer-events-none fixed inset-0 z-[1] overflow-hidden">
          <div className="scanlines absolute inset-0" />
          <div className="scanline-band" />
          <div className="absolute inset-0 bg-[radial-gradient(130%_100%_at_50%_35%,transparent_45%,rgba(2,3,10,0.6)_100%)]" />
          <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-neon/50 to-transparent" />
        </div>

        {/* Layer 3a — projected ambient text (desktop only). */}
        {projection && (
          <div className="pointer-events-none fixed left-[4%] top-1/2 z-[2] hidden w-[min(38vw,400px)] -translate-y-1/2 lg:block xl:left-[6%] xl:w-[440px]">
            {projection}
          </div>
        )}

        {/* Layer 3b — the console: floating HUD glass (center-right desktop,
            bottom sheet mobile). */}
        <div className="fixed inset-x-4 bottom-4 z-[2] mx-auto w-auto max-w-[420px] lg:inset-x-auto lg:bottom-auto lg:right-[4%] lg:top-1/2 lg:mx-0 lg:w-[min(38vw,400px)] lg:-translate-y-1/2 xl:right-[6%] xl:w-[440px]">
          <div className="relative overflow-hidden rounded-2xl border border-white/[0.16] bg-[#0a0b14]/80 shadow-[0_30px_100px_-24px_rgba(0,0,0,0.9),0_0_0_1px_rgba(255,255,255,0.03)_inset] backdrop-blur-xl">
            {/* HUD chrome — top light-line + corner ticks. */}
            <span className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-neon2 to-transparent" />
            <span className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 rounded-tl border-l border-t border-white/40" />
            <span className="pointer-events-none absolute right-2.5 top-2.5 h-3.5 w-3.5 rounded-tr border-r border-t border-white/40" />
            <span className="pointer-events-none absolute bottom-2.5 left-2.5 h-3.5 w-3.5 rounded-bl border-b border-l border-white/40" />
            <span className="pointer-events-none absolute bottom-2.5 right-2.5 h-3.5 w-3.5 rounded-br border-b border-r border-white/40" />
            <div className="max-h-[calc(100dvh-8rem)] overflow-y-auto p-7 sm:p-8">
              {consoleNode}
            </div>
          </div>
        </div>

        {/* Compact mobile brand chip. */}
        {mobileBrand && (
          <div className="fixed left-5 top-5 z-[2] lg:hidden">{mobileBrand}</div>
        )}
      </div>
    );
  }
);

export default AuthStage;
