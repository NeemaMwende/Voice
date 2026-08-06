"use client";

import { Suspense, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import AuthStage from "@/components/AuthStage";
import type { ListeningFieldHandle } from "@/components/ListeningField";
import { IconMic, IconWave, IconSparkle, IconNotes, IconShield } from "@/components/icons";

/**
 * DAXA sign-in — the Listening Chamber's second door.
 *
 * One stable UI, two intents: /signup registers on Keycloak, /login signs in.
 * Both live in the same chamber shell, so the visual language is identical.
 * The bond works the same way — focusing or hovering the CTA makes the room
 * lean in (threads converge, a call halo breathes, the pulse quickens).
 *
 * The callbackUrl (e.g. ?callbackUrl=/recordings from the middleware guard)
 * is preserved: next-auth stores it and restores it after the Keycloak round
 * trip, so a returning user lands where they were headed.
 */
function LoginConsole() {
  const params = useSearchParams();
  const callbackUrl = params.get("callbackUrl") ?? "/";

  const fieldRef = useRef<ListeningFieldHandle>(null);

  /* ── The bond: the console talks to the room. ── */
  const ctaEnter = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    fieldRef.current?.converge(r.left + r.width / 2, r.top + r.height / 2);
  };
  const ctaLeave = () => fieldRef.current?.converge(0, null);
  const ctaDown = (e: ReactPointerEvent<HTMLButtonElement>) =>
    fieldRef.current?.ripple(e.clientX, e.clientY);
  const ctaFocus = () => fieldRef.current?.breathe(0.7);
  const ctaBlur = () => fieldRef.current?.breathe(0);

  /* ── Projected ambient text — lives in the field, left side (desktop). ── */
  const projection = (
    <div>
      <div className="flex items-center gap-3">
        <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-neon to-neon2 shadow-[0_0_24px_rgb(var(--neon)/0.6)]">
          <IconMic className="h-6 w-6 text-white" />
        </div>
        <div>
          <div className="text-xl font-bold tracking-tight text-white">DAXA</div>
          <div className="text-[10px] tracking-[0.15em] text-white/60">AUDIO → NOTES</div>
        </div>
      </div>

      <h1 className="mt-8 text-4xl font-bold leading-[1.1] text-white xl:text-[42px]">
        Pick up where the{" "}
        <span className="bg-gradient-to-r from-neon via-neon2 to-neon3 bg-clip-text text-transparent">
          conversation left off.
        </span>
      </h1>

      <ul className="mt-8 space-y-3 text-[13px] text-white/65">
        {[
          { Icon: IconWave, t: "Accurate transcription — Whisper-powered, word-level timing." },
          { Icon: IconSparkle, t: "AI notes & key points — summaries for every recording." },
          { Icon: IconNotes, t: "Who said what — speaker diarization in the transcript." },
        ].map(({ Icon, t }) => (
          <li key={t} className="flex items-center gap-3">
            <Icon className="h-4 w-4 shrink-0 text-neon2" />
            <span>{t}</span>
          </li>
        ))}
      </ul>

      <p className="mt-10 font-mono text-[10px] uppercase tracking-[0.3em] text-white/55">
        The room is listening
      </p>
    </div>
  );

  /* ── The console — the action, floating in the chamber. ── */
  const consoleNode = (
    <>
      <h2 className="text-xl font-bold tracking-tight text-white">Welcome back</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-white/55">
        Sign in to your DAXA account. Authentication happens on DAXA&apos;s identity
        service — your credentials never touch this app.
      </p>

      <button
        type="button"
        onClick={() => signIn("keycloak", { callbackUrl })}
        onPointerEnter={ctaEnter}
        onPointerLeave={ctaLeave}
        onPointerDown={ctaDown}
        onFocus={ctaFocus}
        onBlur={ctaBlur}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-neon to-neon2 py-3.5 text-sm font-semibold text-white shadow-[0_10px_30px_-10px_rgb(var(--neon))] transition-transform hover:-translate-y-0.5"
      >
        Continue with DAXA
      </button>

      <p className="mt-3 text-center text-[11.5px] leading-relaxed text-white/55">
        You&apos;ll be redirected to the secure DAXA sign-in page.
      </p>

      <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3.5 text-[12px] leading-relaxed text-white/55">
        <IconShield className="mt-0.5 h-4 w-4 shrink-0 text-neon2" />
        <span>
          Your password is handled by DAXA&apos;s identity service — never by this app.
        </span>
      </div>

      <p className="mt-5 text-center text-[13px] text-white/60">
        New to DAXA?{" "}
        <Link href="/signup" className="font-semibold text-neon2 hover:underline">
          Create an account
        </Link>
      </p>
    </>
  );

  /* ── Compact brand for mobile (console becomes a bottom sheet). ── */
  const mobileBrand = (
    <div className="flex items-center gap-2.5">
      <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-neon to-neon2 shadow-[0_0_16px_rgb(var(--neon)/0.5)]">
        <IconMic className="h-5 w-5 text-white" />
      </div>
      <span className="text-lg font-bold tracking-tight text-white">DAXA</span>
    </div>
  );

  return (
    <AuthStage
      ref={fieldRef}
      projection={projection}
      console={consoleNode}
      mobileBrand={mobileBrand}
    />
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="grid min-h-screen place-items-center text-sm text-white/40">
          The room is waking…
        </div>
      }
    >
      <LoginConsole />
    </Suspense>
  );
}
