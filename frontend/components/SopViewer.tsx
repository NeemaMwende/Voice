"use client";

import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Recording, useApp } from "@/context/AppContext";
import { NoteSection, Sop, SopAssessment } from "@/lib/notes";
import {
  deleteSop,
  documentParts,
  fetchAssessment,
  fetchRendered,
  generateSop,
  downloadSop,
  hasSop,
  listToText,
  pairsToText,
  saveSop,
  sectionsToText,
  sopProgress,
  textToList,
  textToPairs,
  textToSections,
} from "@/lib/sop";
import {
  IconAlert,
  IconCopy,
  IconDoc,
  IconDownload,
  IconEdit,
  IconFilePdf,
  IconRefresh,
  IconSparkle,
  IconTrash,
} from "./icons";
import { toast } from "./Toast";

/**
 * The SOP tab.
 *
 * Nothing is generated until it is asked for. Most conversations aren't
 * procedural, so the tab opens on the backend's read of this particular
 * recording — how much business content survived the small-talk pass — and the
 * user decides. When that read is negative the button says "Generate anyway"
 * rather than disappearing: the heuristic is advice, not a veto, and the model
 * gets its own say afterwards (a 422 comes back here as the reason it declined).
 *
 * Once a document exists it can be read here, edited in place, re-generated, or
 * downloaded as .txt / .pdf. Editing writes back through the backend so the
 * downloads always match what's on screen.
 */
export default function SopViewer({ rec }: { rec: Recording }) {
  const { patchRecording } = useApp();
  // hasSop, not `rec.sop`: the stored column defaults to {}, which is truthy.
  const [sop, setSop] = useState<Sop | null>(hasSop(rec.sop) ? rec.sop : null);
  const [assessment, setAssessment] = useState<SopAssessment | null>(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [detail, setDetail] = useState("");
  const [declined, setDeclined] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };
  useEffect(() => stopPolling, []);

  // The assessment is cheap (no model runs) so it's fetched on open and again
  // after anything changes what it would say. One retry, because a recording
  // that has only just been transcribed is still being POSTed to the backend
  // when this first runs — a 404 here is a race, not an answer.
  const refreshAssessment = useCallback(async () => {
    for (const delay of [0, 1200]) {
      if (delay) await new Promise((done) => setTimeout(done, delay));
      try {
        setAssessment(await fetchAssessment(rec.id));
        return;
      } catch (err) {
        console.error("Could not read the SOP assessment:", err);
      }
    }
    setAssessment(null);
  }, [rec.id]);

  useEffect(() => {
    void refreshAssessment();
  }, [refreshAssessment]);

  const store = (doc: Sop | null) => {
    setSop(doc);
    patchRecording(rec.id, { sop: doc ?? undefined });
  };

  const generate = async () => {
    if (busy) return;
    setBusy(true);
    setDeclined(null);
    setPct(0);
    setDetail("Starting…");

    const jobId = crypto.randomUUID();
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const p = await sopProgress(jobId);
        if (p.stage === "unknown") return;
        setPct((prev) => Math.max(prev, Math.round(p.pct)));
        setDetail(p.label ?? "");
      } catch {
        // a dropped poll is harmless — the next tick catches up
      }
    }, 700);

    try {
      const doc = await generateSop(rec.id, jobId);
      store(doc);
      setPct(100);
      toast("SOP generated");
      void refreshAssessment();
    } catch (err) {
      const message = err instanceof Error ? err.message : "SOP generation failed";
      setDeclined(message);
      toast(message);
    } finally {
      stopPolling();
      setBusy(false);
      setDetail("");
    }
  };

  const discard = async () => {
    try {
      await deleteSop(rec.id);
      store(null);
      setEditing(false);
      setConfirmDiscard(false);
      toast("SOP discarded");
      void refreshAssessment();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not discard the SOP");
    }
  };

  const persist = async (next: Sop) => {
    try {
      const saved = await saveSop(rec.id, next);
      store(saved);
      setEditing(false);
      toast("SOP saved");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Could not save the SOP");
    }
  };

  const copy = async () => {
    try {
      const text = await (await fetchRendered(rec.id, "txt")).text();
      await navigator.clipboard.writeText(text);
      toast("SOP copied to clipboard");
    } catch {
      toast("Copy not available");
    }
  };

  const download = async (ext: "txt" | "pdf") => {
    try {
      await downloadSop(rec.id, ext, sop?.title ?? rec.title);
      toast(`Downloaded the ${ext.toUpperCase()}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : `Could not download the ${ext}`);
    }
  };

  if (busy && !sop) return <Working pct={pct} detail={detail} />;

  if (!sop) {
    return (
      <GeneratePrompt
        assessment={assessment}
        declined={declined}
        onGenerate={generate}
        busy={busy}
      />
    );
  }

  return (
    <div className="space-y-4">
      {busy && <Working pct={pct} detail={detail} compact />}

      {editing ? (
        <SopEditor sop={sop} onCancel={() => setEditing(false)} onSave={persist} />
      ) : (
        <SopDocument sop={sop} recording={rec} />
      )}

      {!editing && (
        <>
          {declined && <Note tone="warn">{declined}</Note>}
          <div className="flex flex-wrap gap-2 border-t border-white/[0.08] pt-4">
            <Action onClick={() => setEditing(true)} icon={<IconEdit className="h-4 w-4" />}>
              Edit
            </Action>
            <Action
              onClick={generate}
              disabled={busy}
              icon={<IconRefresh className="h-4 w-4" />}
            >
              Regenerate
            </Action>
            <Action onClick={copy} icon={<IconCopy className="h-4 w-4" />}>
              Copy
            </Action>
            <Action
              onClick={() => download("txt")}
              icon={<IconDownload className="h-4 w-4" />}
            >
              .txt
            </Action>
            {assessment?.pdf !== false && (
              <Action
                onClick={() => download("pdf")}
                icon={<IconFilePdf className="h-4 w-4" />}
              >
                .pdf
              </Action>
            )}
            <div className="flex-1" />
            {confirmDiscard ? (
              <>
                <button
                  onClick={discard}
                  className="rounded-xl bg-neon3/15 px-3.5 py-2.5 text-[12.5px] font-semibold text-neon3 transition-colors hover:bg-neon3/25"
                >
                  Discard for good
                </button>
                <button
                  onClick={() => setConfirmDiscard(false)}
                  className="rounded-xl px-3 py-2.5 text-[12.5px] text-muted hover:text-white"
                >
                  Keep it
                </button>
              </>
            ) : (
              <Action
                onClick={() => setConfirmDiscard(true)}
                icon={<IconTrash className="h-4 w-4" />}
              >
                Discard
              </Action>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The conditional. Everything the user needs to decide sits in one panel: how
 * much business content there is, where it would be written from, and what the
 * model would be asked to do. `suitable: false` changes the wording and the tone
 * of the button — it never removes it.
 */
function GeneratePrompt({
  assessment,
  declined,
  onGenerate,
  busy,
}: {
  assessment: SopAssessment | null;
  declined: string | null;
  onGenerate: () => void;
  busy: boolean;
}) {
  const suitable = assessment?.suitable ?? true;
  const disabled = busy || assessment?.available === false;
  const writer = assessment?.model ? ` by ${assessment.model}` : "";
  const provenance =
    `Written from ${assessment?.source ?? "the cleaned transcript"}${writer} — ` +
    "a couple of minutes on the local model. Nothing is generated until you ask.";

  return (
    <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] px-6 py-7 text-center">
      <div
        className={`mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl ${
          suitable ? "bg-neon/15 text-neon2" : "bg-warn/10 text-warn"
        }`}
      >
        {suitable ? <IconDoc className="h-6 w-6" /> : <IconAlert className="h-6 w-6" />}
      </div>

      <h4 className="text-[15px] font-semibold">
        {suitable
          ? "Turn this conversation into an SOP?"
          : "This may not be worth an SOP"}
      </h4>
      <p className="mx-auto mt-2 max-w-[46ch] text-[12.5px] leading-relaxed text-muted">
        {assessment?.reason ??
          "Reading this recording… the SOP is written from the cleaned transcript, with the small talk already removed."}
      </p>

      {assessment && (
        <div className="mx-auto mt-4 flex max-w-[34rem] flex-wrap items-center justify-center gap-x-5 gap-y-1.5 text-[11px] text-muted">
          <Stat label="business words" value={assessment.businessWords} />
          {assessment.sentences > 0 && (
            <Stat
              label="off-topic sentences"
              value={`${assessment.smallTalk} of ${assessment.sentences}`}
            />
          )}
        </div>
      )}

      {declined && (
        <div className="mx-auto mt-4 max-w-[46ch]">
          <Note tone="warn">{declined}</Note>
        </div>
      )}

      <button
        onClick={onGenerate}
        disabled={disabled}
        className={`mt-6 inline-flex items-center gap-2 rounded-xl px-5 py-3 text-[13px] font-semibold transition-transform disabled:cursor-not-allowed disabled:opacity-50 ${
          suitable
            ? "bg-gradient-to-br from-neon to-neon2 text-white hover:-translate-y-0.5"
            : "border border-warn/30 bg-warn/10 text-warn hover:bg-warn/20"
        }`}
      >
        <IconSparkle className="h-4 w-4" />
        {suitable ? "Generate SOP" : "Generate anyway"}
      </button>

      <p className="mx-auto mt-3 max-w-[52ch] text-[11px] leading-relaxed text-muted">
        {assessment?.available === false
          ? "SOP generation is switched off on the server (SOP=0)."
          : provenance}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="font-semibold text-[#cfd3f0]">{value}</span>
      {label}
    </span>
  );
}

/** Live progress while the model writes — the same channel the transcription uses. */
function Working({
  pct,
  detail,
  compact,
}: {
  pct: number;
  detail: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border border-white/[0.08] bg-white/[0.03] px-6 ${
        compact ? "py-4" : "py-8 text-center"
      }`}
    >
      {!compact && (
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-neon/15 text-neon2">
          <IconDoc className="h-6 w-6 animate-pulse" />
        </div>
      )}
      <div className="mb-2 flex items-center justify-between gap-3 text-[12.5px]">
        <span className="font-semibold">Writing the procedure…</span>
        <span className="text-muted">{pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/[0.07]">
        <div
          className="h-full rounded-full bg-[linear-gradient(90deg,#7c5cff,#00e5ff,#ff4ecd)] bg-[length:200%_100%] animate-flow transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1.5 text-[11.5px] text-muted">{detail}</div>
    </div>
  );
}

// ── The document ────────────────────────────────────────────────────────────

/**
 * The SOP as a document, laid out the way the printed one is: an organisation
 * banner, the reference block, then numbered parts. The .txt and .pdf are
 * rendered by the backend from the same object, so this is a faithful preview
 * rather than a second implementation of the layout.
 */
function SopDocument({ sop, recording }: { sop: Sop; recording: Recording }) {
  const parts = documentParts(sop);
  const generated = sop.generatedAt ? new Date(sop.generatedAt).toLocaleString() : "—";

  return (
    <article className="rounded-2xl border border-white/[0.09] bg-white/[0.03] px-5 py-5 md:px-7 md:py-6">
      {/* banner */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/[0.1] pb-3">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-sm bg-warn" />
          <span className="text-[12.5px] font-bold uppercase tracking-[0.08em]">
            {sop.organisation ?? "Techno Brain"}
          </span>
        </div>
        <span className="rounded border border-warn/40 px-2.5 py-1 text-[9.5px] font-bold uppercase tracking-[0.12em] text-warn">
          Standard Operating Procedure
        </span>
      </header>

      <h3 className="mt-5 text-[19px] font-bold leading-snug text-[#eef0ff]">{sop.title}</h3>

      <dl className="mt-3 grid gap-x-6 gap-y-1 border-b border-white/[0.08] pb-4 text-[11.5px] sm:grid-cols-2">
        <Meta label="Document ref" value={sop.code} />
        <Meta label="Status" value={sop.edited ? `${sop.status ?? "Draft"} · edited` : sop.status ?? "Draft"} />
        <Meta label="Source recording" value={recording.title} />
        <Meta label="Generated" value={`${generated}${sop.model ? ` · ${sop.model}` : ""}`} />
      </dl>

      <div className="mt-5 space-y-6">
        {parts.map((part) => (
          <section key={part.number}>
            <h4 className="mb-2 text-[12.5px] font-bold uppercase tracking-[0.06em] text-[#e6e9ff]">
              {part.number}. {part.heading}
            </h4>

            {part.paragraph && (
              <p className="text-[13.5px] leading-relaxed text-[#cfd3f0]">{part.paragraph}</p>
            )}

            {part.bullets && <SquareBullets items={part.bullets} />}

            {part.pairs && (
              <div className="space-y-1.5 text-[13.5px] leading-relaxed text-[#cfd3f0]">
                {part.pairs.map(([term, meaning]) => (
                  <p key={term}>
                    <span className="font-semibold text-[#eef0ff]">{term}</span> — {meaning}
                  </p>
                ))}
              </div>
            )}

            {part.sections?.map((section, i) => (
              <div key={`${section.heading}-${i}`} className="mt-3 first:mt-0">
                <h5 className="mb-1.5 text-[12.5px] font-semibold text-[#dfe2fb]">
                  {part.number}.{i + 1} {section.heading}
                </h5>
                {section.body && (
                  <p className="text-[13.5px] leading-relaxed text-[#cfd3f0]">{section.body}</p>
                )}
                {section.bullets && <SquareBullets items={section.bullets} />}
              </div>
            ))}
          </section>
        ))}
      </div>

      <footer className="mt-6 border-t border-white/[0.08] pt-3 text-[11px] italic text-muted">
        Drafted automatically from {sop.source || "the cleaned transcript"}. Review and
        approve it before it is issued or relied upon.
      </footer>
    </article>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 font-semibold text-[#dfe2fb]">{value}</dd>
    </div>
  );
}

/** The small orange square the printed procedures use as a bullet. */
function SquareBullets({ items }: { items: string[] }) {
  return (
    <ul className="mt-1.5 space-y-1.5 text-[13.5px] leading-relaxed text-[#cfd3f0]">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5">
          <span className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-[1px] bg-warn" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

// ── The editor ──────────────────────────────────────────────────────────────

type Draft = {
  title: string;
  purpose: string;
  scope: string;
  definitions: string;
  sections: string;
  responsibilities: string;
  monitoring: string;
  openItems: string;
};

const toDraft = (sop: Sop): Draft => ({
  title: sop.title ?? "",
  purpose: sop.purpose ?? "",
  scope: listToText(sop.scope ?? []),
  definitions: pairsToText(sop.definitions ?? [], "term", "meaning"),
  sections: sectionsToText(sop.sections ?? []),
  responsibilities: pairsToText(sop.responsibilities ?? [], "role", "duty"),
  monitoring: sop.monitoring ?? "",
  openItems: listToText(sop.openItems ?? []),
});

/**
 * Edits each part of the document as plain text — one item per line for lists,
 * `Term — meaning` for pairs, `## Heading` + `- bullet` for the procedure — and
 * parses it back into the stored structure on save. The backend re-validates
 * whatever arrives, so a malformed edit can't corrupt the document.
 */
function SopEditor({
  sop,
  onCancel,
  onSave,
}: {
  sop: Sop;
  onCancel: () => void;
  onSave: (next: Sop) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(sop));
  const set = (key: keyof Draft) => (value: string) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const save = () => {
    const sections: NoteSection[] = textToSections(draft.sections);
    onSave({
      ...sop,
      title: draft.title.trim() || sop.title,
      purpose: draft.purpose.trim(),
      scope: textToList(draft.scope),
      definitions: textToPairs(draft.definitions, "term", "meaning"),
      sections,
      responsibilities: textToPairs(draft.responsibilities, "role", "duty"),
      monitoring: draft.monitoring.trim(),
      openItems: textToList(draft.openItems),
    });
  };

  return (
    <div className="space-y-4 rounded-2xl border border-neon/25 bg-neon/[0.04] px-5 py-5">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-neon2">
        <IconEdit className="h-3.5 w-3.5" /> Editing the procedure
      </div>

      <Field label="Title" hint="the procedure's name, as it appears on the document">
        <input
          value={draft.title}
          onChange={(e) => set("title")(e.target.value)}
          className="w-full rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2.5 text-[13.5px] font-semibold text-white outline-none transition-colors focus:border-neon2"
        />
      </Field>

      <Field label="1. Purpose" hint="a short paragraph">
        <Area value={draft.purpose} onChange={set("purpose")} rows={4} />
      </Field>

      <Field label="2. Scope" hint="one line per item">
        <Area value={draft.scope} onChange={set("scope")} rows={3} />
      </Field>

      <Field label="3. Definitions" hint="one per line, as “Term — meaning”">
        <Area value={draft.definitions} onChange={set("definitions")} rows={3} />
      </Field>

      <Field
        label="4. Procedure"
        hint="“## Heading” starts a stage; plain lines are its intro, “- ” lines are its steps"
      >
        <Area value={draft.sections} onChange={set("sections")} rows={12} mono />
      </Field>

      <Field label="5. Responsibilities" hint="one per line, as “Role — duty”">
        <Area value={draft.responsibilities} onChange={set("responsibilities")} rows={3} />
      </Field>

      <Field label="6. Monitoring and enforcement" hint="a short paragraph; leave empty to omit">
        <Area value={draft.monitoring} onChange={set("monitoring")} rows={3} />
      </Field>

      <Field label="7. Open items and review" hint="one line per item">
        <Area value={draft.openItems} onChange={set("openItems")} rows={3} />
      </Field>

      <div className="flex flex-wrap gap-2 border-t border-white/[0.08] pt-4">
        <button
          onClick={save}
          className="flex items-center gap-2 rounded-xl bg-gradient-to-br from-neon to-neon2 px-4 py-2.5 text-[12.5px] font-semibold text-white transition-transform hover:-translate-y-0.5"
        >
          Save changes
        </button>
        <button
          onClick={onCancel}
          className="rounded-xl border border-white/10 bg-white/[0.06] px-4 py-2.5 text-[12.5px] font-semibold text-muted transition-colors hover:text-white"
        >
          Cancel
        </button>
        <span className="ml-auto self-center text-[11px] text-muted">
          Empty parts are dropped from the document, and the numbering closes up.
        </span>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[11.5px] font-semibold text-[#e6e9ff]">{label}</span>
      <span className="ml-2 text-[11px] text-muted">{hint}</span>
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

function Area({
  value,
  onChange,
  rows,
  mono,
}: {
  value: string;
  onChange: (value: string) => void;
  rows: number;
  mono?: boolean;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full resize-y rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2.5 text-[13px] leading-relaxed text-[#dfe2fb] outline-none transition-colors focus:border-neon2 ${
        mono ? "font-mono text-[12px]" : ""
      }`}
    />
  );
}

// ── Bits ────────────────────────────────────────────────────────────────────

function Note({ tone, children }: { tone: "warn"; children: ReactNode }) {
  return (
    <p
      className={`flex items-start gap-2 rounded-xl border px-3.5 py-2.5 text-left text-[12px] leading-relaxed ${
        tone === "warn" ? "border-warn/25 bg-warn/[0.07] text-warn" : ""
      }`}
    >
      <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Action({
  onClick,
  icon,
  disabled,
  children,
}: {
  onClick: () => void;
  icon: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-3.5 py-2.5 text-[12.5px] font-semibold text-[#d3d7f5] transition-colors hover:bg-white/[0.1] hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
    >
      {icon}
      {children}
    </button>
  );
}
