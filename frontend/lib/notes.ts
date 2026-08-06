export type NoteSection = { heading: string; body?: string; bullets?: string[] };

export type Speaker = {
  id: string;
  name: string;
  /** hex accent used for the avatar + name */
  color: string;
};

/**
 * One sentence of a turn. `label` is the relevance verdict: "business" content
 * feeds the notes (and later the SOP), "smalltalk" is set aside — but never
 * deleted, so the transcript can always show what was excluded and why.
 */
export type SentenceSpan = {
  raw: string;
  clean: string;
  label: "business" | "smalltalk";
  reason?: string;
};

export type Segment = {
  speakerId: string;
  /** start offset in seconds */
  tSec: number;
  /** exactly what was said — fillers, stutters, background noise */
  raw: string;
  /** the same turn after noise + filler removal; every topic still present */
  clean: string;
  /** cleaned business content only, with the small talk dropped */
  relevant?: string;
  /** per-sentence breakdown; absent on recordings made before this existed */
  sentences?: SentenceSpan[];
};

/** One `Term — meaning` entry in an SOP's definitions list. */
export type SopDefinition = { term: string; meaning: string };

/** One `Role — duty` entry in an SOP's responsibilities list. */
export type SopResponsibility = { role: string; duty: string };

/**
 * A generated Standard Operating Procedure — the document the backend writes
 * from the cleaned transcript (see `backend/sop.py`), laid out like a company
 * policy: numbered parts, each with prose, bullets or `term — meaning` pairs.
 *
 * Present only on recordings the user asked for one on: most conversations
 * aren't procedural, so this is normally absent. The .txt and .pdf downloads are
 * rendered by the backend from this same object, so an edit here changes both.
 */
export type Sop = {
  title: string;
  /** derived document reference, e.g. TBL.SOP.CLIENT.4A2F */
  code: string;
  purpose: string;
  scope: string[];
  definitions: SopDefinition[];
  /** the procedure itself — one entry per stage of the work */
  sections: NoteSection[];
  responsibilities: SopResponsibility[];
  monitoring: string;
  /** questions, blockers and decisions the conversation left open */
  openItems: string[];
  status?: string;
  organisation?: string;
  /** which tier it was written from: the business record or the transcript */
  source?: string;
  model?: string;
  generatedAt?: number;
  edited?: boolean;
  editedAt?: number;
};

/**
 * The backend's read on whether a recording is worth an SOP — a word count and
 * a small-talk tally, no model involved. `suitable` is advice only: the user can
 * always generate anyway, which is the whole point of the conditional flow.
 */
export type SopAssessment = {
  suitable: boolean;
  reason: string;
  /** false when SOP generation is switched off server-side */
  available: boolean;
  /** whether reportlab is installed, i.e. whether the PDF download works */
  pdf: boolean;
  businessWords: number;
  businessRatio: number;
  smallTalk: number;
  sentences: number;
  source: string;
  hasRecord: boolean;
  hasSop: boolean;
  model: string;
};

/**
 * Shape of a transcription result, independent of the id/file metadata.
 *
 * The note sections (`summary` … `outline`) are what the Notes tab renders —
 * the raw transcript lives only in `transcript`/`segments` and is shown on the
 * Transcript tab. Everything after `key` is optional so recordings saved before
 * those sections existed still load.
 */
export type NoteContent = {
  title: string;
  transcript: string;
  speakers: Speaker[];
  segments: Segment[];
  /** overview — the "what was this about" paragraph(s) */
  summary: NoteSection[];
  /**
   * The business record: prose paragraphs the model extracted from the cleaned
   * transcript, covering the process, steps, rules, figures and decisions. This
   * is what the SOP gets generated from, and what the Transcript tab shows under
   * "Business only" — it is a written account, not a transcript.
   */
  businessSummary?: string;
  /** key points */
  key: string[];
  actionItems?: string[];
  /** themed groups: decisions, risks, numbers, … */
  insights?: NoteSection[];
  /** chronological topic-by-topic breakdown of the conversation */
  outline?: NoteSection[];
  /**
   * The Standard Operating Procedure, once the user has asked for one. Absent
   * on every recording nobody generated one for — which is most of them. Test
   * it with `hasSop` from ./sop, never for truthiness: the stored column
   * defaults to an empty object.
   */
  sop?: Sop | null;
  tags: string[];
  durationSec: number;
};

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** mm:ss timestamp for a transcript segment */
export function fmtStamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function fmtSize(bytes: number): string {
  return bytes < 1e6 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

/** initials for a speaker avatar */
export function initials(name: string): string {
  const parts = name.replace(/[—–-]/g, " ").trim().split(/\s+/);
  return (parts[0][0] + (parts[1]?.[0] ?? "")).toUpperCase();
}

export type DiffToken = { text: string; removed: boolean };

/**
 * Word-level diff between the verbatim (`raw`) turn and its cleaned version.
 * Tokens present in raw but dropped from clean are flagged `removed` — i.e.
 * the fillers / stutters / background noise the model stripped out. When raw
 * and clean are identical (e.g. a straight Whisper transcript) nothing is
 * flagged.
 */
export function diffRaw(raw: string, clean: string): DiffToken[] {
  const rTok = raw.match(/\S+|\s+/g) ?? [];
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const rWords = rTok.filter((t) => /\S/.test(t)).map(norm);
  const cWords = (clean.match(/\S+/g) ?? []).map(norm);

  // LCS over normalized words → which raw words survive in clean
  const n = rWords.length;
  const m = cWords.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = rWords[i] === cWords[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const kept = new Array(n).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (rWords[i] === cWords[j]) {
      kept[i] = true;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  // map kept-flags (indexed over non-space words) back onto the full token list
  const out: DiffToken[] = [];
  let wi = 0;
  for (const t of rTok) {
    if (/\S/.test(t)) {
      out.push({ text: t, removed: !kept[wi] });
      wi++;
    } else {
      out.push({ text: t, removed: false });
    }
  }
  return out;
}
