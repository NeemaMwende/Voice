/**
 * Client side of the SOP feature: the calls to the backend, and the codec the
 * editor uses.
 *
 * The document itself is always structured (see `Sop` in ./notes) because the
 * backend renders the .txt and the .pdf from that structure. But editing nested
 * arrays through a wall of inputs is miserable, so each part of the document is
 * edited as plain text in a small, obvious convention and parsed back on save:
 *
 *   lists          one item per line
 *   pairs          `Term — meaning`, one per line
 *   sections       `## Heading`, then prose lines, then `- bullet` lines
 *
 * Everything is re-validated server-side too (`sop.sanitize`), so a malformed
 * edit can't corrupt the stored document.
 */

import { NoteSection, Sop, SopAssessment } from "./notes";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

/**
 * Does this recording actually have an SOP?
 *
 * Not just `!!rec.sop`: the column defaults to an empty object, and `{}` is
 * truthy — which would badge every recording in the library as having a
 * procedure. A real document always has a title.
 */
export const hasSop = (sop?: Sop | null): sop is Sop => !!sop?.title?.trim();

/** Pull `detail` off a FastAPI error body, falling back to the status. */
async function failure(res: Response, fallback: string): Promise<Error> {
  try {
    const body = await res.json();
    if (typeof body?.detail === "string" && body.detail) return new Error(body.detail);
  } catch {
    // not JSON — the status is all we have
  }
  return new Error(`${fallback} (${res.status})`);
}

export async function fetchAssessment(id: string): Promise<SopAssessment> {
  const res = await fetch(`${API_URL}/recordings/${id}/sop/assessment`);
  if (!res.ok) throw await failure(res, "Could not read the SOP assessment");
  return res.json();
}

/**
 * Generate the SOP. Minutes of local-model time, so `jobId` opts into the same
 * /progress channel the transcription uses.
 */
export async function generateSop(id: string, jobId?: string): Promise<Sop> {
  const query = jobId ? `?job_id=${encodeURIComponent(jobId)}` : "";
  const res = await fetch(`${API_URL}/recordings/${id}/sop${query}`, { method: "POST" });
  if (!res.ok) throw await failure(res, "SOP generation failed");
  return res.json();
}

export async function saveSop(id: string, sop: Sop): Promise<Sop> {
  const res = await fetch(`${API_URL}/recordings/${id}/sop`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sop),
  });
  if (!res.ok) throw await failure(res, "Could not save the SOP");
  return res.json();
}

export async function deleteSop(id: string): Promise<void> {
  const res = await fetch(`${API_URL}/recordings/${id}/sop`, { method: "DELETE" });
  if (!res.ok) throw await failure(res, "Could not discard the SOP");
}

/** Progress for an in-flight generation — same shape as the transcription's. */
export async function sopProgress(
  jobId: string
): Promise<{ pct: number; stage: string; label: string; done: boolean }> {
  const res = await fetch(`${API_URL}/progress/${jobId}`);
  if (!res.ok) throw new Error(`progress failed (${res.status})`);
  return res.json();
}

/** The rendered document, as the download would contain it. */
export async function fetchRendered(id: string, ext: "txt" | "pdf"): Promise<Blob> {
  const res = await fetch(`${API_URL}/recordings/${id}/sop.${ext}`);
  if (!res.ok) throw await failure(res, `Could not render the ${ext.toUpperCase()}`);
  return res.blob();
}

/**
 * Save a blob to disk. Fetched rather than linked because `download` is ignored
 * on cross-origin hrefs — the backend is a different origin, so a plain link
 * would open the file instead of saving it.
 */
export async function downloadSop(id: string, ext: "txt" | "pdf", title: string): Promise<void> {
  const blob = await fetchRendered(id, ext);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug(title)}-sop.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sop";
}

// ── The document's parts, in order ──────────────────────────────────────────

export type SopPart = {
  number: number;
  heading: string;
  paragraph?: string;
  bullets?: string[];
  pairs?: [string, string][];
  sections?: NoteSection[];
};

/**
 * Split an SOP into its numbered parts for display. Deliberately the same order
 * and the same drop-if-empty rule as `_parts` in `backend/sop.py`, so what the
 * screen shows and what the .txt/.pdf contain are numbered identically. An empty
 * part is omitted rather than shown blank, so the numbering never skips.
 */
export function documentParts(sop: Sop): SopPart[] {
  const parts: Omit<SopPart, "number">[] = [];

  if (sop.purpose?.trim()) parts.push({ heading: "Purpose", paragraph: sop.purpose.trim() });
  if (sop.scope?.length) parts.push({ heading: "Scope", bullets: sop.scope });
  if (sop.definitions?.length) {
    parts.push({
      heading: "Definitions",
      pairs: sop.definitions.map((d) => [d.term, d.meaning]),
    });
  }
  if (sop.sections?.length) parts.push({ heading: "Procedure", sections: sop.sections });
  if (sop.responsibilities?.length) {
    parts.push({
      heading: "Responsibilities",
      pairs: sop.responsibilities.map((r) => [r.role, r.duty]),
    });
  }
  if (sop.monitoring?.trim()) {
    parts.push({ heading: "Monitoring and enforcement", paragraph: sop.monitoring.trim() });
  }
  if (sop.openItems?.length) {
    parts.push({ heading: "Open items and review", bullets: sop.openItems });
  }

  return parts.map((part, i) => ({ ...part, number: i + 1 }));
}

// ── Editor codec ────────────────────────────────────────────────────────────

const DASH = "—";

/** What counts as `term — meaning`: the dash we write, and what a keyboard has. */
const PAIR_SEPARATORS = [" — ", " – ", " - ", ": "];

const BULLET_MARKERS = "-*•";

const isBullet = (line: string) => line.length > 1 && BULLET_MARKERS.includes(line[0]);
const isHeading = (line: string) => line.startsWith("#");

export const listToText = (items: string[]): string => (items ?? []).join("\n");

export const textToList = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .map((line) => (isBullet(line) ? line.slice(1).trim() : line))
    .filter(Boolean);

/** The earliest `term — meaning` split in a line, or null if there isn't one. */
function splitPair(line: string): [string, string] | null {
  let at = -1;
  let separator = "";
  for (const candidate of PAIR_SEPARATORS) {
    const found = line.indexOf(candidate);
    // Split at the FIRST separator only, so a meaning may contain a dash of its
    // own without losing half of itself here.
    if (found > 0 && (at < 0 || found < at)) {
      at = found;
      separator = candidate;
    }
  }
  if (at < 0) return null;
  const term = line.slice(0, at).trim();
  const meaning = line.slice(at + separator.length).trim();
  return term && meaning ? [term, meaning] : null;
}

export function pairsToText<A extends string, B extends string>(
  pairs: Record<A | B, string>[],
  first: A,
  second: B
): string {
  return (pairs ?? []).map((p) => `${p[first]} ${DASH} ${p[second]}`).join("\n");
}

export function textToPairs<A extends string, B extends string>(
  text: string,
  first: A,
  second: B
): Record<A | B, string>[] {
  return textToList(text)
    .map((line) => splitPair(line))
    .filter((pair): pair is [string, string] => pair !== null)
    .map(([a, b]) => ({ [first]: a, [second]: b }) as Record<A | B, string>);
}

/** `## Heading` / prose / `- bullet` → the structured sections. */
export function textToSections(text: string): NoteSection[] {
  const sections: NoteSection[] = [];
  let current: NoteSection | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;

    if (isHeading(line)) {
      current = { heading: line.replace(/^#+/, "").trim(), body: "", bullets: [] };
      sections.push(current);
      continue;
    }
    // Content typed before the first heading still deserves to survive the edit.
    if (!current) {
      current = { heading: "", body: "", bullets: [] };
      sections.push(current);
    }

    if (isBullet(line)) {
      current.bullets = [...(current.bullets ?? []), line.slice(1).trim()];
    } else {
      current.body = current.body ? `${current.body} ${line}` : line;
    }
  }

  return sections.filter((s) => s.heading || s.body || s.bullets?.length);
}

export function sectionsToText(sections: NoteSection[]): string {
  return (sections ?? [])
    .map((s) =>
      [
        `## ${s.heading}`,
        ...(s.body ? [s.body] : []),
        ...(s.bullets ?? []).map((b) => `- ${b}`),
      ].join("\n")
    )
    .join("\n\n");
}
