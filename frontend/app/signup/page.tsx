"use client";

import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import AuthStage from "@/components/AuthStage";
import type { ListeningFieldHandle } from "@/components/ListeningField";
import { IconMic, IconWave, IconSparkle, IconNotes, IconLock, IconShield } from "@/components/icons";

/**
 * DAXA sign-up — the Listening Chamber.
 *
 * The voice field IS the page: a fullscreen living constellation. The form
 * floats inside it as a HUD console (center-right). The bond: focusing or
 * hovering the CTA makes the room lean in (threads converge, a call halo
 * breathes, the listening pulse quickens); pressing it sends a ripple.
 *
 * Accounts are created on Keycloak (the identity provider), not in this app —
 * passwords never touch DAXA's code.
 */
const ISSUER =
  process.env.NEXT_PUBLIC_KEYCLOAK_ISSUER ?? "http://localhost:8080/realms/daxa";
const CLIENT_ID = process.env.NEXT_PUBLIC_KEYCLOAK_CLIENT_ID ?? "daxa-web";
const CALLBACK = encodeURIComponent(
  (process.env.NEXT_PUBLIC_NEXTAUTH_URL ?? "http://localhost:3000") +
    "/api/auth/callback/keycloak"
);
const REGISTER_URL = `${ISSUER}/protocol/openid-connect/registrations?client_id=${CLIENT_ID}&response_type=code&scope=openid%20profile%20email&redirect_uri=${CALLBACK}`;

export default function SignupPage() {
  const fieldRef = useRef<ListeningFieldHandle>(null);

  /* ── The bond: the console talks to the room. ── */
  const ctaEnter = (e: ReactPointerEvent<HTMLAnchorElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    fieldRef.current?.converge(r.left + r.width / 2, r.top + r.height / 2);
  };
  const ctaLeave = () => fieldRef.current?.converge(0, null);
  const ctaDown = (e: ReactPointerEvent<HTMLAnchorElement>) =>
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
        Turn any conversation into a{" "}
        <span className="bg-gradient-to-r from-neon via-neon2 to-neon3 bg-clip-text text-transparent">
          searchable, speaker-split transcript.
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
      <h2 className="text-xl font-bold tracking-tight text-white">Create your account</h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-white/55">
        Accounts are managed by DAXA&apos;s identity service. Registration happens on a
        secure page — your credentials never touch this app.
      </p>

      <a
        href={REGISTER_URL}
        onPointerEnter={ctaEnter}
        onPointerLeave={ctaLeave}
        onPointerDown={ctaDown}
        onFocus={ctaFocus}
        onBlur={ctaBlur}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-br from-neon to-neon2 py-3.5 text-sm font-semibold text-white shadow-[0_10px_30px_-10px_rgb(var(--neon))] transition-transform hover:-translate-y-0.5"
      >
        <IconLock className="h-4 w-4" />
        Create account with DAXA
      </a>

      <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3.5 text-[12px] leading-relaxed text-white/55">
        <IconShield className="mt-0.5 h-4 w-4 shrink-0 text-neon2" />
        <span>
          Your name, email and password are handled by DAXA&apos;s identity service — never by
          this app.
        </span>
      </div>

      <p className="mt-5 text-center text-[13px] text-white/60">
        Already have an account?{" "}
        <Link href="/login" className="font-semibold text-neon2 hover:underline">
          Log in
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
