"use client";

/**
 * ListeningField — zero-dependency, cursor-reactive "listening field".
 *
 * A voice constellation rendered on 2D canvas: words as glowing nodes laid out
 * along per-speaker threads, cross-talk as faint arcs, a periodic "listening"
 * sweep, and a cursor that acts as a listening probe (proximity brightens,
 * attracts, and reveals a word tooltip). Clicking a node emits a signal ripple.
 *
 * Design contract (from the Slice-1 research verdict):
 *  - Pure 2D canvas. No three.js, no new dependencies.
 *  - Dark surface regardless of app theme (holograms are additive-on-black).
 *  - Accent-aware: reads --neon / --neon2 / --neon3 from the theme root, so the
 *    panel glow and sweep follow whatever accent the user picked in Settings.
 *  - prefers-reduced-motion → static render: no drift, no sweep, no parallax.
 *    Hover/click still work (state change, not motion).
 *  - WCAG-minded: a pause control for the ambient loop, no strobe above 3 Hz
 *    (one smooth sweep every ~5s), motion is decorative only — the canvas is
 *    aria-hidden and a plain-text caption is provided.
 *  - Performance: DPR capped at 2, all glow drawn from pre-rendered sprites,
 *    rAF paused on tab hide / pause / reduced-motion, scene fully deterministic
 *    (seeded PRNG) so the layout never jumps between renders.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

/** Imperative control surface used by parent pages to "talk to" the field.
 *  - breathe(0..1): console attention — quickens the listening pulse, brightens nodes.
 *  - converge(x, y | null): threads + nodes lean toward a viewport point (e.g. the CTA).
 *  - ripple(x, y): emit a signal pulse from a viewport point.
 *  All calls are no-ops under prefers-reduced-motion (the field stays static). */
export interface ListeningFieldHandle {
  breathe(level: number): void;
  converge(x: number, y: number | null): void;
  ripple(x: number, y: number): void;
}

export interface ListeningFieldProps {
  className?: string;
  /** "hero" = contained panel (login brand panel). "chamber" = fullscreen living background. */
  variant?: "hero" | "chamber";
}

/* ── Tunables ─────────────────────────────────────────────────────── */
const SEED = 0xd4aabee; // deterministic scene
const HERO_WORDS = 160; // nodes in the hero constellation
const CHAMBER_WORDS = 240; // nodes when the field IS the room
const HERO_DUST = 150; // ambient particles (hero)
const CHAMBER_DUST = 220; // ambient particles (chamber)
const PROXIMITY_RADIUS = 110; // px — attraction + soft brighten
const HOVER_RADIUS = 90; // px — tooltip + edge highlight
const MAX_OFFSET = 22; // px — cap on cursor attraction
const PULSE_EVERY = 5.2; // s — the "listening" sweep cadence
const PULSE_DURATION = 2.1; // s — sweep travel time
const PARALLAX = 14; // px — max camera tilt toward cursor

/* Voice rhythm (chamber variant only) — a calm, speech-like cadence: sonar
 * rings emanate from a focal point, and a live voice meter scrolls across the
 * middle of the screen — 48 waveform bars that rise and fall with the voice,
 * flat when silent. The console's bond (attention) quickens and brightens the
 * rhythm. */
const RHYTHM_BPM = 76; // the room's pulse (~0.79 s per beat)
const RHYTHM_PERIOD = 60 / RHYTHM_BPM;
const RHYTHM_LIFE = 3.2; // s — a sonar ring's lifetime before fading out
const BAR_COUNT = 48; // waveform bars across the center line (matches LiveRecorder)
const BAR_SAMPLES = 720; // envelope samples feeding the bars (8 s window)
const BAR_RATE = 90; // envelope samples per second of generator time
const BAR_AMP = 0.3; // fraction of H — max bar height at full voice

/* Mirror of the transcript speaker palette (TranscriptView.tsx) — kept local
 * so this component stays decoupled; update both if the palette changes. */
const SPEAKER_COLORS = ["#7c5cff", "#00e5ff", "#ff4ecd", "#2ee6a6", "#ffb454"];
const SPEAKER_NAMES = ["Alex", "Sarah", "Mia", "Jordan"];

/* Conversation-flavored word pool. Fillers get low confidence, echoing DAXA's
 * raw-vs-clean (filler stripping) story: uncertain words render hollow/dim. */
const WORD_POOL = [
  "budget", "timeline", "design", "launch", "review", "client", "Q3", "feedback",
  "prototype", "metrics", "roadmap", "demo", "deadline", "priority", "deploy",
  "testing", "okay", "right", "maybe", "actually", "think", "yeah", "so", "um",
  "well", "planning", "scope", "handoff", "stakeholder", "iteration", "polish",
  "ship", "sync", "standup", "feature", "data", "growth", "risk", "owner", "wrap",
  "finalize", "approve", "draft", "notes", "action", "items", "tomorrow", "monday",
  "thanks", "perfect", "sounds", "good", "sure", "awesome", "hold on", "exactly",
  "probably", "honestly", "works", "tricky", "easy", "fast", "done", "next",
  "agreed", "fair", "quick", "update", "track", "ticket", "bug", "edge case",
  "regression", "rollout", "sprint", "backlog", "retro", "blockers", "dependencies",
  "verify",
];
const FILLERS = new Set(["um", "yeah", "so", "well", "okay", "right", "actually", "probably", "maybe"]);

/* ── Types ────────────────────────────────────────────────────────── */
type RGB = [number, number, number];

interface WordNode {
  id: number;
  text: string;
  speaker: number;
  /** normalized 0..1 time position */
  x: number;
  /** normalized 0..1 band position */
  y: number;
  /** model confidence 0..1 (drives brightness) */
  p: number;
  /** filler word → rendered as a hollow ring (low trust) */
  filler: boolean;
  /** cursor-attraction offset, px (animation state) */
  ox: number;
  oy: number;
}

interface CrossLink {
  a: number;
  b: number;
}

interface Dust {
  x: number;
  y: number;
  r: number;
  a: number;
  sp: number;
  ph: number;
  sprite: 0 | 1;
}

/* ── Helpers ──────────────────────────────────────────────────────── */

/** Deterministic PRNG so the constellation is identical on every render. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Blend a hex color toward the room's slate so vivid hues recede — the
 * constellation should read as structure, not paint. */
function muteHex(hex: string, mix: number): RGB {
  const [r, g, b] = hexToRgb(hex);
  const t = (c: number) => Math.round(c + (134 - c) * mix); // 134 ≈ slate blue-gray
  return [t(r), t(g), t(b)];
}
/** Pre-muted speaker tints (≈55% slate) for quiet background nodes/threads. */
const NODE_TINTS: RGB[] = SPEAKER_COLORS.map((h) => muteHex(h, 0.55));
/** rgba() string of a muted speaker tint at the given alpha. */
function tint(speaker: number, alpha: number): string {
  const t = NODE_TINTS[speaker];
  return `rgba(${t[0]},${t[1]},${t[2]},${alpha})`;
}

/** Pre-rendered radial-glow sprite — the hologram's "additive dot". */
function makeGlowSprite(r: number, g: number, b: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
  grad.addColorStop(0.35, `rgba(${r},${g},${b},0.35)`);
  grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);
  return c;
}

/** Accent triad from the theme root (`--neon` etc. are "R G B" triplets). */
function readAccent(): { a1: RGB; a2: RGB; a3: RGB } {
  const s = getComputedStyle(document.documentElement);
  const parse = (v: string, fallback: string): RGB => {
    const m = (v || fallback).trim().split(/\s+/).map(Number);
    return [m[0] ?? 124, m[1] ?? 92, m[2] ?? 255];
  };
  return {
    a1: parse(s.getPropertyValue("--neon"), "124 92 255"),
    a2: parse(s.getPropertyValue("--neon2"), "0 229 255"),
    a3: parse(s.getPropertyValue("--neon3"), "255 78 205"),
  };
}

/** Build the full deterministic scene: words, cross-talk, neighbor links. */
function buildScene(rnd: () => number, wordCount: number): {
  words: WordNode[];
  cross: CrossLink[];
  neighbors: number[][];
  threads: number[][];
} {
  const words: WordNode[] = [];
  let t = 0.02;
  let spk = Math.floor(rnd() * SPEAKER_NAMES.length);
  let run = 2;

  for (let i = 0; i < wordCount; i++) {
    if (run-- <= 0) {
      spk = (spk + 1 + Math.floor(rnd() * (SPEAKER_NAMES.length - 1))) % SPEAKER_NAMES.length;
      run = 1 + Math.floor(rnd() * 5);
    }
    t += 0.004 + rnd() * 0.011;
    const text = WORD_POOL[Math.floor(rnd() * WORD_POOL.length)];
    const filler = FILLERS.has(text) && rnd() < 0.6;
    const p = filler ? 0.38 + rnd() * 0.22 : 0.7 + rnd() * 0.29;
    words.push({ id: i, text, speaker: spk, x: t, y: 0, p, filler, ox: 0, oy: 0 });
  }

  const tMax = words[words.length - 1].x;
  for (const w of words) w.x /= tMax;

  // Per-speaker wave bands — organic, never colliding.
  for (const w of words) {
    const yBase = 0.15 + w.speaker * 0.235;
    w.y = yBase + Math.sin(w.x * Math.PI * 2 * 1.4 + w.speaker * 1.7) * 0.045 + (rnd() - 0.5) * 0.02;
  }

  // Same-speaker temporal neighbors (prev/next in time).
  const neighbors: number[][] = words.map(() => [] as number[]);
  const threads: number[][] = SPEAKER_NAMES.map(() => []);
  for (const w of words) threads[w.speaker].push(w.id);
  for (const ids of threads) {
    ids.sort((a, b) => words[a].x - words[b].x);
    for (let i = 0; i < ids.length; i++) {
      if (i > 0) neighbors[ids[i]].push(ids[i - 1]);
      if (i < ids.length - 1) neighbors[ids[i]].push(ids[i + 1]);
    }
  }

  // Cross-talk: pair words from different speakers that land close in time.
  const cross: CrossLink[] = [];
  const attempts = new Set<number>();
  for (let i = 0; i < 6 && attempts.size < wordCount; i++) {
    const a = words[Math.floor(rnd() * words.length)];
    if (attempts.has(a.id)) continue;
    attempts.add(a.id);
    let best = -1;
    let bestD = Infinity;
    for (const w of words) {
      if (w.speaker === a.speaker) continue;
      const d = Math.abs(w.x - a.x);
      if (d < bestD) {
        bestD = d;
        best = w.id;
      }
    }
    if (best >= 0 && bestD < 0.12) {
      cross.push({ a: a.id, b: best });
      neighbors[a.id].push(best);
      neighbors[best].push(a.id);
    }
  }

  return { words, cross, neighbors, threads };
}

/* ── Voice envelope generator (chamber) ───────────────────────────────
 * A live-recording read of the room: mostly a flat line; when "voice is
 * detected" it fires soft syllable pulses (a small onset swell followed by a
 * main peak) at syllable cadence, riding a slow phrase swell and the rhythm
 * beat. Speech bursts come and go via seeded value noise — voice "coming in
 * and going out". Deterministic: same seed → same envelope. */

/** Smooth deterministic value noise — cheap, seedable, no allocations. */
function vnoise(x: number, seed: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const hash = (n: number): number => {
    let s = Math.imul(n ^ Math.imul(seed, 0x9e3779b9), 0x85ebca6b) >>> 0;
    s = (s ^ (s >>> 13)) >>> 0;
    s = Math.imul(s, 0xc2b2ae35) >>> 0;
    return ((s ^ (s >>> 16)) >>> 0) / 4294967296;
  };
  const a = hash(i);
  const b = hash(i + 1);
  const u = f * f * (3 - 2 * f);
  return a + (b - a) * u;
}

/**
 * One voice-envelope sample at generator time `st` (seconds). `attn` 0..1 is
 * the console bond — attention makes the room "hear" more.
 */
function sampleVoice(st: number, attn: number): number {
  const period = RHYTHM_PERIOD * (1 - attn * 0.22);
  // Speech bursts — slow seeded noise, roughly -1..1, smoothed toward 0..1.
  const burst =
    0.55 * (vnoise(st * 0.5, 11) - 0.5) * 2 + 0.45 * (vnoise(st * 1.7, 23) - 0.5) * 2;
  const b = Math.max(0, Math.min(1, (burst + 1) / 2));
  const talking = b > 0.44;
  if (!talking) return (vnoise(st * 47, 7) - 0.5) * 0.03; // flat silence jitter

  // Voice active: amplitude rides the phrase swell + beat + attention.
  const phrase = 0.5 + 0.5 * Math.sin(st * 2 * Math.PI * 0.16 + 0.7);
  const beat = Math.exp(-(((st % period) / period) * 3.2));
  const act = (0.4 + 0.6 * phrase) * (0.55 + 0.45 * beat) * (0.6 + attn * 0.6);
  // Syllable pulses — a soft onset plus a main peak every ~0.26-0.4 s while
  // talking; smooth enough for the waveform bars to read as voice, not noise.
  const gap = 0.26 + 0.14 * vnoise(st * 3.1, 31);
  const ph = (st % gap) / gap;
  const syl =
    0.5 * Math.exp(-Math.pow((ph - 0.22) * 8, 2)) + 0.85 * Math.exp(-Math.pow((ph - 0.6) * 6, 2));
  return act * (0.75 * syl + 0.25 * (vnoise(st * 23, 5) - 0.5));
}

/* ── Component ────────────────────────────────────────────────────── */

const ListeningField = forwardRef<ListeningFieldHandle, ListeningFieldProps>(
  function ListeningField({ className, variant = "hero" }, ref) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const tipRef = useRef<HTMLDivElement>(null);

    const [paused, setPaused] = useState(false);
    const [reduced, setReduced] = useState(false);

    const pausedRef = useRef(paused);
    const reducedRef = useRef(reduced);
    const syncRef = useRef<() => void>(() => {});

    /* Bond state — the console "talks to" the field through these refs. */
    const attnTargetRef = useRef(0); // requested attention 0..1 (focus)
    const attnRef = useRef(0); // smoothed attention (animation state)
    const convTargetRef = useRef<{ x: number; y: number } | null>(null);
    const convRef = useRef<{ x: number; y: number } | null>(null); // smoothed convergence point
    const ripplesRef = useRef<{ x: number; y: number; age: number }[]>([]);

    /* Voice-rhythm state (chamber only). */
    const rhythmTimeRef = useRef(0); // running time of the rhythm clock, s
    const envRef = useRef({ env: 0.5, beat: 0 }); // {phrase swell, beat envelope}
    const ringRefs = useRef<number[]>([]); // ages of live sonar rings, s

    const wordCount = variant === "chamber" ? CHAMBER_WORDS : HERO_WORDS;
    const dustCount = variant === "chamber" ? CHAMBER_DUST : HERO_DUST;
    const isChamber = variant === "chamber";

    useImperativeHandle(
      ref,
      () => ({
        breathe(level: number) {
          attnTargetRef.current = Math.max(0, Math.min(1, level));
        },
        converge(x: number, y: number | null) {
          convTargetRef.current = y === null ? null : { x, y };
        },
        ripple(x: number, y: number) {
          if (reducedRef.current || pausedRef.current) return;
          ripplesRef.current.push({ x, y, age: 0 });
        },
      }),
      []
    );

    useEffect(() => {
      pausedRef.current = paused;
      syncRef.current();
    }, [paused]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    /* ── Scene data (deterministic) ── */
    const rnd = mulberry32(SEED);
    const { words, cross, neighbors, threads } = buildScene(rnd, wordCount);
    const accent = readAccent();
    // Glow sprites for the voice meter's three energy tiers (violet → cyan → pink).
    const spriteA1 = makeGlowSprite(...accent.a1);
    const spriteAccent2 = makeGlowSprite(...accent.a2);
    const spriteA3 = makeGlowSprite(...accent.a3);
    const spriteWhite = makeGlowSprite(255, 255, 255);

    const dust: Dust[] = [];
    for (let i = 0; i < dustCount; i++) {
      dust.push({
        x: rnd(),
        y: rnd(),
        r: 0.6 + rnd() * 1.6,
        a: 0.05 + rnd() * 0.2,
        sp: 0.05 + rnd() * 0.18,
        ph: rnd() * Math.PI * 2,
        sprite: rnd() > 0.55 ? 0 : 1,
      });
    }
    const dustSprites = [spriteAccent2, spriteWhite];

    /* Voice-rhythm scene data (chamber only): staggered pre-seeded ring ages
     * so the room is already breathing on first paint. The voice meter is
     * pre-filled just below (it lives in render state). */
    if (isChamber) ringRefs.current = [0.6, 1.5, 2.4];

    /* ── Render state ── */
    let W = 0;
    let H = 0;
    let dpr = 1;
    let nodeR = 2;
    let raf = 0;
    let running = false;
    let time = 0;
    let last = 0;
    let pulseT = -1;
    let nextPulse = 2.5;
    const cursor = { x: -999, y: -999, nx: 0.5, ny: 0.5, inside: false };
    let hoverId = -1;
    const par = { x: 0, y: 0 };
    /* Voice meter (chamber): envelope samples scroll left as generator time
     * advances. Pre-filled with 8 s of deterministic "voice" history so the
     * bars are live — and reduced-motion safe — from the very first frame. */
    const barBuf: number[] = [];
    const barCur: number[] = []; // spring-smoothed bar heights
    const barPeaks: number[] = []; // peak-hold caps that decay slowly
    let genT = 0;
    let scrollAcc = 0;

    /* Integration helper — the mean+peak blend over one bar's slice. The
     * peak weighting keeps the meter lively: syllables read as tall bars. */
    const barTarget = (i: number): number => {
      const slice = Math.max(1, barBuf.length / BAR_COUNT);
      const s0 = Math.floor(i * slice);
      const s1 = Math.min(barBuf.length, Math.floor((i + 1) * slice));
      let mx = 0;
      let sum = 0;
      for (let j = s0; j < s1; j++) {
        const v = barBuf[j];
        if (v > mx) mx = v;
        sum += v;
      }
      return 0.4 * (sum / (s1 - s0)) + 0.6 * mx;
    };

    if (isChamber) {
      for (let i = 0; i < BAR_SAMPLES; i++) barBuf.push(sampleVoice((i - BAR_SAMPLES) / BAR_RATE, 0));
      for (let i = 0; i < BAR_COUNT; i++) {
        const v = barTarget(i);
        barCur.push(v);
        barPeaks.push(v);
      }
    }

    /* ── Sizing ── */
    const resize = () => {
      const rect = container.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = rect.width;
      H = rect.height;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Chamber uses smaller nodes so the voice meter stays the focal point.
      nodeR = Math.min(4.2, 1.3 + Math.min(W, H) / 110) * (isChamber ? 0.6 : 1);
    }

    /* ── Interaction helpers ── */
    const toLocal = (e: PointerEvent) => {
      const r = container.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function nearestNode(x: number, y: number, radius: number): number {
      let best = -1;
      let bd = radius * radius;
      for (const w of words) {
        const dx = w.x * W + w.ox - x;
        const dy = w.y * H + w.oy - y;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = w.id;
        }
      }
      return best;
    }

    /* ── Tooltip (DOM, outside the render loop) ── */
    const tip = tipRef.current;
    const tipDot = tip?.querySelector<HTMLElement>(".lf-dot") ?? null;
    const tipWord = tip?.querySelector<HTMLElement>(".lf-word") ?? null;
    const tipMeta = tip?.querySelector<HTMLElement>(".lf-meta") ?? null;

    function updateTooltip() {
      if (!tip || !tipDot || !tipWord || !tipMeta) return;
      if (hoverId < 0) {
        tip.style.opacity = "0";
        return;
      }
      const w = words[hoverId];
      tipDot.style.background = SPEAKER_COLORS[w.speaker];
      tipWord.textContent = w.text;
      tipMeta.textContent = `${SPEAKER_NAMES[w.speaker]} · ${Math.round(w.p * 100)}%`;
      const px = Math.min(Math.max(w.x * W + w.ox + 14, 6), Math.max(6, W - 150));
      const py = Math.min(Math.max(w.y * H + w.oy + 14, 6), Math.max(6, H - 42));
      tip.style.transform = `translate3d(${px}px, ${py}px, 0)`;
      tip.style.opacity = "1";
    }

    /* ── Per-frame signals ── */
    function proximityBoost(px: number, py: number): number {
      if (!cursor.inside) return 0;
      const dx = px - cursor.x;
      const dy = py - cursor.y;
      const d2 = dx * dx + dy * dy;
      const R = PROXIMITY_RADIUS;
      return d2 < R * R ? (1 - d2 / (R * R)) * 0.9 : 0;
    }

    function pulseBoost(px: number): number {
      if (pulseT < 0 || pulseT > 1) return 0;
      const d = Math.abs(px - pulseT * W) / (W * 0.06);
      return Math.exp(-d * d) * 0.9;
    }

    /* ── Frame updates ── */
    function update(dt: number) {
      time += dt;

      // Cursor parallax — the field leans toward the probe.
      const tx = cursor.inside ? (cursor.nx - 0.5) * 2 * PARALLAX : 0;
      const ty = cursor.inside ? (cursor.ny - 0.5) * 2 * PARALLAX : 0;
      par.x += (tx - par.x) * 0.06;
      par.y += (ty - par.y) * 0.06;

      // Bond: attention (console focus) eases in/out.
      attnRef.current += (attnTargetRef.current - attnRef.current) * 0.08;

      // Bond: convergence target (console call point), converted to local coords.
      const ct = convTargetRef.current;
      if (ct) convRef.current = { x: ct.x - par.x, y: ct.y - par.y };
      else convRef.current = null;

      // Attraction: nodes near the cursor drift toward it, then spring back.
      for (const w of words) {
        const px = w.x * W;
        const py = w.y * H;
        let tx2 = 0;
        let ty2 = 0;
        if (cursor.inside) {
          const dx = cursor.x - px;
          const dy = cursor.y - py;
          const d2 = dx * dx + dy * dy;
          const R = PROXIMITY_RADIUS;
          if (d2 < R * R) {
            const f = (1 - d2 / (R * R)) * 0.5;
            tx2 = dx * f;
            ty2 = dy * f;
          }
        }
        // Bond: the room leans toward the console's call point.
        if (convRef.current) {
          const dx = convRef.current.x - px;
          const dy = convRef.current.y - py;
          const d2 = dx * dx + dy * dy;
          const R = 420 * 420;
          if (d2 < R) {
            const f = (1 - d2 / R) * 0.5;
            tx2 += dx * f * 0.35;
            ty2 += dy * f * 0.35;
          }
        }
        const mag = Math.hypot(tx2, ty2);
        if (mag > MAX_OFFSET) {
          tx2 = (tx2 / mag) * MAX_OFFSET;
          ty2 = (ty2 / mag) * MAX_OFFSET;
        }
        w.ox += (tx2 - w.ox) * 0.08;
        w.oy += (ty2 - w.oy) * 0.08;
      }

      // Listening sweep — cadence quickens as the console demands attention.
      if (pulseT >= 0) {
        pulseT += dt / (PULSE_DURATION * (1 - attnRef.current * 0.25));
        if (pulseT > 1) pulseT = -1;
      }
      if (time >= nextPulse) {
        pulseT = 0;
        nextPulse = time + PULSE_EVERY - attnRef.current * 2.6;
      }

      for (const r of ripplesRef.current) r.age += dt;

      // Voice rhythm (chamber): phrase swell + beat envelope. A new sonar ring
      // spawns on every beat; the bond (console attention) quickens the beat.
      if (isChamber) {
        rhythmTimeRef.current += dt;
        const t = rhythmTimeRef.current;
        const period = RHYTHM_PERIOD * (1 - attnRef.current * 0.22);
        const phrase = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 0.16 + 0.7);
        const beat = Math.exp(-(((t % period) / period) * 3.2));
        envRef.current = { env: 0.35 + 0.65 * phrase, beat };
        const prev = (t - dt) % period;
        const cur = t % period;
        if (cur < prev) ringRefs.current.push(0);
        for (let i = 0; i < ringRefs.current.length; i++) ringRefs.current[i] += dt;
        ringRefs.current = ringRefs.current.filter((a) => a < RHYTHM_LIFE);

        // The voice meter scrolls left in real time; new "voice" envelope
        // samples arrive on the right edge (time-based, constant speed).
        scrollAcc += dt * BAR_RATE;
        const n = Math.floor(scrollAcc);
        if (n > 0) {
          scrollAcc -= n;
          barBuf.splice(0, n);
          const attn = attnRef.current;
          for (let k = 0; k < n; k++) {
            genT += 1 / BAR_RATE;
            barBuf.push(sampleVoice(genT, attn));
          }
        }

        // Spring-smooth each bar toward its target so the meter ripples like a
        // live recording; peak caps hold bright, then decay.
        for (let i = 0; i < BAR_COUNT; i++) {
          const t = barTarget(i);
          const k = 0.06 + ((i * 37) % 11) / 180; // per-bar stiffness → organic wave
          barCur[i] += (t - barCur[i]) * k;
          if (barCur[i] > barPeaks[i]) barPeaks[i] = barCur[i];
          else barPeaks[i] -= dt * 0.55;
          if (barPeaks[i] < 0) barPeaks[i] = 0;
        }
      }

      // Nodes moved under attraction → keep the tooltip pinned to its node.
      if (hoverId >= 0) updateTooltip();
    }

    /* ── Draw ── */
    const draw = () => {
      if (W === 0 || H === 0) return;
      ctx.clearRect(0, 0, W, H);
      ctx.save();
      ctx.translate(par.x, par.y);
      ctx.globalCompositeOperation = "lighter";

      // Dust — ambient particles with slow organic drift.
      const k = Math.min(W, H) / 300;
      for (const d of dust) {
        const dx = (d.x + Math.sin(time * d.sp * 0.3 + d.ph) * 0.01) * W;
        const dy = (d.y + Math.cos(time * d.sp * 0.4 + d.ph) * 0.01) * H;
        const s = d.r * 8 * k;
        ctx.globalAlpha = d.a * (1 + attnRef.current * 0.5) * (isChamber ? 0.7 + 0.6 * envRef.current.env : 1);
        ctx.drawImage(dustSprites[d.sprite], dx - s / 2, dy - s / 2, s, s);
      }

      // Voice rhythm (chamber) — the live voice meter: 48 waveform bars that
      // rise and fall with the voice, flat when silent, scrolling left like a
      // live recording. The console glass and projection sit above it.
      if (isChamber) {
        const by = H * 0.5;
        // Bars swell with each beat of the rhythm, so the meter visibly
        // "moves with the voice" even between syllables.
        const amp = H * BAR_AMP * (1 + attnRef.current * 0.4) * (1 + envRef.current.beat * 0.18);
        const bw = W / BAR_COUNT;

        // Rounded-rect fill helper (roundRect with a plain-rect fallback).
        const rr = ctx as CanvasRenderingContext2D & {
          roundRect?: (x: number, y: number, w: number, h: number, r: number) => void;
        };
        const fillBar = (x: number, y: number, w: number, h: number, r: number) => {
          if (rr.roundRect) {
            rr.beginPath();
            rr.roundRect(x, y, w, h, r);
            rr.fill();
          } else {
            ctx.fillRect(x, y, w, h);
          }
        };

        // Faint baseline guide — the meter's reference line.
        ctx.strokeStyle = "rgba(255,255,255,0.05)";
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 7]);
        ctx.beginPath();
        ctx.moveTo(0, by);
        ctx.lineTo(W, by);
        ctx.stroke();
        ctx.setLineDash([]);

        // Bars ride the spring-smoothed envelope (computed in update), so the
        // meter ripples organically; each bar leaves a phosphor glow as the
        // meter scrolls, and bright peak caps hold, then decay.
        for (let i = 0; i < BAR_COUNT; i++) {
          const v = barCur[i];
          const h = Math.max(3, v * amp);
          const w = bw * 0.32; // slim bars — height does the talking
          const x = i * bw + (bw - w) / 2;
          const sprite = v > 0.5 ? spriteA3 : v > 0.26 ? spriteAccent2 : spriteA1;
          // Passing glow — a comet smear swept left of the bar (the direction
          // the meter scrolls), then a tight halo hugging the bar itself.
          ctx.globalAlpha = 0.16 * (0.3 + v);
          ctx.drawImage(sprite, x - w * 2.6, by - h / 2 - h * 0.18, w * 3.6, h * 1.36);
          ctx.globalAlpha = 0.22 * (0.2 + v);
          ctx.drawImage(sprite, x - w * 0.9, by - h / 2 - h * 0.2, w * 1.8, h * 1.4);
          // Crisp rounded bar.
          ctx.globalAlpha = 0.85;
          fillBar(x, by - h / 2, w, h, Math.min(2.5, w / 2));
          // Peak-hold cap — a bright tick that lingers above the body.
          const pk = barPeaks[i] * amp;
          if (pk > h + 1.5) {
            ctx.globalAlpha = 0.9;
            ctx.fillStyle = "rgba(255,255,255,0.9)";
            ctx.fillRect(x - 1, by - pk / 2 - 1, w + 2, 2);
          }
        }
        ctx.globalAlpha = 1;

        // Sonar rings — the voice source breathing at its focal point.
        const fx = W * 0.3;
        const fy = H * 0.5;
        const rmax = Math.min(W, H) * 0.55;
        const ages = reducedRef.current ? [0.9, 1.8, 2.7] : ringRefs.current;
        for (const a of ages) {
          const p = a / RHYTHM_LIFE;
          if (p >= 1) continue;
          const r = p * rmax;
          const alpha = (1 - p) * 0.16 * (1 + attnRef.current * 0.5);
          ctx.strokeStyle = `rgba(${accent.a1[0]},${accent.a1[1]},${accent.a1[2]},${alpha})`;
          ctx.lineWidth = 1.1;
          ctx.beginPath();
          ctx.arc(fx, fy, r, 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 5;
          ctx.globalAlpha = alpha * 0.35;
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        // Focal glow — the source itself, swelling on each beat.
        const gs = rmax * 0.5 * (1 + envRef.current.beat * 0.25 + attnRef.current * 0.2);
        ctx.globalAlpha = 0.1 + envRef.current.beat * 0.1;
        ctx.drawImage(spriteAccent2, fx - gs, fy - gs, gs * 2, gs * 2);
        ctx.globalAlpha = 1;
      }

      // Cross-talk arcs — faint connecting curves between overlapping voices.
      for (const c of cross) {
        const a = words[c.a];
        const b = words[c.b];
        const ax = a.x * W + a.ox;
        const ay = a.y * H + a.oy;
        const bx = b.x * W + b.ox;
        const by = b.y * H + b.oy;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.quadraticCurveTo((ax + bx) / 2, (ay + by) / 2 - 16, bx, by);
        ctx.strokeStyle = "rgba(255,255,255,0.09)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // Speaker threads — smooth paths through each speaker's words. When the
      // console calls (bond convergence), thread midpoints bend toward it.
      for (let s = 0; s < threads.length; s++) {
        const ids = threads[s];
        if (ids.length < 2) continue;
        ctx.beginPath();
        const p0 = words[ids[0]];
        ctx.moveTo(p0.x * W + p0.ox, p0.y * H + p0.oy);
        for (let i = 1; i < ids.length - 1; i++) {
          const a = words[ids[i]];
          const b = words[ids[i + 1]];
          let mx = ((a.x + b.x) / 2) * W + (a.ox + b.ox) / 2;
          let my = ((a.y + b.y) / 2) * H + (a.oy + b.oy) / 2;
          if (convRef.current) {
            mx += (convRef.current.x - mx) * 0.22;
            my += (convRef.current.y - my) * 0.22;
          }
          ctx.quadraticCurveTo(a.x * W + a.ox, a.y * H + a.oy, mx, my);
        }
        const lastW = words[ids[ids.length - 1]];
        ctx.lineTo(lastW.x * W + lastW.ox, lastW.y * H + lastW.oy);
        ctx.strokeStyle = tint(s, 0.1 + attnRef.current * 0.08);
        ctx.lineWidth = 1.25;
        ctx.stroke();
      }

      // Hover highlight — illuminate the hovered node's links.
      if (hoverId >= 0) {
        for (const n of neighbors[hoverId]) {
          const a = words[hoverId];
          const b = words[n];
          ctx.beginPath();
          ctx.moveTo(a.x * W + a.ox, a.y * H + a.oy);
          ctx.lineTo(b.x * W + b.ox, b.y * H + b.oy);
          ctx.strokeStyle = tint(a.speaker, 0.5);
          ctx.lineWidth = 1.6;
          ctx.stroke();
        }
      }

      // Nodes — crisp dots (or hollow rings for low-trust fillers).
      for (const w of words) {
        const px = w.x * W + w.ox;
        const py = w.y * H + w.oy;
        const boost = proximityBoost(px, py);
        const flare = pulseBoost(px);
        const s = nodeR * (0.7 + w.p * 0.5) * (1 + boost * 0.5 + flare * 0.6) * (isChamber ? 1 + envRef.current.beat * 0.06 : 1);
        const hover = w.id === hoverId;
        const alpha = Math.min(
          1,
          0.35 + 0.6 * w.p + boost * 0.3 + flare * 0.35 + attnRef.current * 0.25 +
            (isChamber ? envRef.current.beat * 0.12 : 0)
        );

        if (w.filler) {
          // Hollow ring — "heard, but not trusted".
          ctx.globalAlpha = alpha * 0.7;
          ctx.strokeStyle = tint(w.speaker, 1);
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(px, py, s * 1.7, 0, Math.PI * 2);
          ctx.stroke();
          continue;
        }

        // Crisp dot — muted tint so the constellation recedes into the
        // background; hover grows the dot and brings it forward.
        const dot = Math.max(2.2, s * (hover ? 2.2 : 1.4));
        ctx.globalAlpha = hover ? 0.9 : Math.min(0.55, alpha * 0.6);
        ctx.fillStyle = tint(w.speaker, 1);
        ctx.beginPath();
        ctx.arc(px, py, dot, 0, Math.PI * 2);
        ctx.fill();
        // Soft center — a dim white core keeps the dot alive.
        ctx.globalAlpha = hover ? 0.85 : Math.min(0.4, alpha * 0.45);
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.beginPath();
        ctx.arc(px, py, Math.max(1, dot * 0.4), 0, Math.PI * 2);
        ctx.fill();
      }

      // Listening sweep — soft band + leading line.
      if (pulseT >= 0 && pulseT <= 1) {
        const px = pulseT * W;
        const band = ctx.createLinearGradient(px - 60, 0, px + 60, 0);
        band.addColorStop(0, "rgba(255,255,255,0)");
        band.addColorStop(0.5, "rgba(255,255,255,0.06)");
        band.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = band;
        ctx.fillRect(px - 60, 0, 120, H);
        ctx.strokeStyle = `rgba(${accent.a1[0]},${accent.a1[1]},${accent.a1[2]},0.22)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(px, 0);
        ctx.lineTo(px, H);
        ctx.stroke();
      }

      // Signal ripples — from clicked nodes and from the console's CTA.
      for (const rp of ripplesRef.current) {
        const t = rp.age / 0.8;
        if (t >= 1) continue;
        const r = 8 + 42 * (1 - Math.pow(1 - t, 3));
        ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - t)})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = `rgba(${accent.a1[0]},${accent.a1[1]},${accent.a1[2]},${0.45 * (1 - t)})`;
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, r * 0.7, 0, Math.PI * 2);
        ctx.stroke();
      }
      ripplesRef.current = ripplesRef.current.filter((rp) => rp.age <= 0.8);

      // Bond: the console's call halo — a soft ring that breathes at the CTA.
      if (convRef.current) {
        const cx = convRef.current.x;
        const cy = convRef.current.y;
        const br = 30 + Math.sin(time * 1.6) * 5;
        ctx.strokeStyle = `rgba(${accent.a1[0]},${accent.a1[1]},${accent.a1[2]},0.45)`;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(cx, cy, br, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = `rgba(${accent.a2[0]},${accent.a2[1]},${accent.a2[2]},0.28)`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(cx, cy, br * 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
    }

    /* ── Loop management ── */
    function tick(now: number) {
      raf = requestAnimationFrame(tick);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      update(dt);
      draw();
    }

    function start() {
      if (running || reducedRef.current || pausedRef.current || document.hidden) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }

    function stop() {
      running = false;
      cancelAnimationFrame(raf);
    }

    syncRef.current = () => {
      if (reducedRef.current || pausedRef.current || document.hidden) stop();
      else start();
    };

    /* ── Events ── */
    function onMove(e: PointerEvent) {
      const { x, y } = toLocal(e);
      cursor.x = x;
      cursor.y = y;
      cursor.nx = W ? x / W : 0.5;
      cursor.ny = H ? y / H : 0.5;
      cursor.inside = true;
      const h = nearestNode(x, y, HOVER_RADIUS);
      if (h !== hoverId) {
        hoverId = h;
        updateTooltip();
      }
      if (reducedRef.current) draw(); // static repaint on interaction only
    }

    function onLeave() {
      cursor.inside = false;
      cursor.x = -999;
      cursor.y = -999;
      if (hoverId >= 0) {
        hoverId = -1;
        updateTooltip();
      }
      if (reducedRef.current) draw();
    }

    function onDown(e: PointerEvent) {
      if ((e.target as HTMLElement).closest("button")) return;
      const { x, y } = toLocal(e);
      const n = nearestNode(x, y, 26);
      if (n >= 0) {
        ripplesRef.current.push({ x: words[n].x * W + words[n].ox, y: words[n].y * H + words[n].oy, age: 0 });
      }
    }

    container.addEventListener("pointermove", onMove);
    container.addEventListener("pointerleave", onLeave);
    container.addEventListener("pointerdown", onDown);

    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedRef.current = mq.matches;
    setReduced(mq.matches);
    const onMq = (e: MediaQueryListEvent) => {
      reducedRef.current = e.matches;
      setReduced(e.matches);
      syncRef.current();
      if (e.matches) draw(); // static fallback
    };
    mq.addEventListener("change", onMq);

    const onVisibility = () => syncRef.current();
    document.addEventListener("visibilitychange", onVisibility);

    const ro = new ResizeObserver(() => {
      resize();
      if (!running) draw();
    });
    ro.observe(container);

    /* ── Boot ── */
    resize();
    draw();
    syncRef.current();

    /* ── Cleanup ── */
    return () => {
      stop();
      container.removeEventListener("pointermove", onMove);
      container.removeEventListener("pointerleave", onLeave);
      container.removeEventListener("pointerdown", onDown);
      mq.removeEventListener("change", onMq);
      document.removeEventListener("visibilitychange", onVisibility);
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    reducedRef.current = reduced;
    syncRef.current();
  }, [reduced]);

  return (
    <div
      ref={containerRef}
      className={`${
        variant === "chamber"
          ? "fixed inset-0 bg-[#07070e]"
          : "relative overflow-hidden rounded-2xl border border-white/[0.07] bg-[#07070e] shadow-[0_24px_70px_-24px_rgba(0,0,0,0.85)]"
      } ${className ?? ""}`}
    >
      {/* Accent bleed from the theme — follows the user's chosen accent. */}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(120%_100%_at_50%_0%,rgb(var(--neon)/0.12),transparent_60%)]" />
      {/* Faint hologram scanlines + vignette — owned by the hero panel; the
          chamber variant gets its chrome from the page's AuthStage instead. */}
      {variant !== "chamber" && (
        <>
          <div className="pointer-events-none absolute inset-0 opacity-[0.05] bg-[repeating-linear-gradient(0deg,rgba(255,255,255,0.5)_0px,rgba(255,255,255,0.5)_1px,transparent_1px,transparent_3px)]" />
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_90%_at_50%_50%,transparent_55%,rgba(0,0,0,0.5)_100%)]" />
        </>
      )}

      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 h-full w-full" />

      {/* HUD caption — honest, static, informative. */}
      <div
        className={`pointer-events-none absolute font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/55 ${
          variant === "chamber" ? "left-5 top-4" : "bottom-2.5 left-3.5"
        }`}
      >
        {SPEAKER_NAMES.length} voices · {wordCount} words · listening{isChamber ? " · rhythm" : ""}
      </div>

      {/* Ambient-loop pause control (WCAG 2.2.2 spirit; hidden when static). */}
      {!reduced && (
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          aria-pressed={paused}
          aria-label={paused ? "Play ambient animation" : "Pause ambient animation"}
          className={`absolute grid h-6 w-6 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-white/50 transition-colors hover:bg-white/10 hover:text-white/80 ${
            variant === "chamber" ? "right-5 top-4 h-7 w-7" : "right-2.5 top-2.5"
          }`}
        >
          {paused ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
              <path d="M2.2 1.3a.5.5 0 0 1 .78-.41l6 3.7a.5.5 0 0 1 0 .82l-6 3.7a.5.5 0 0 1-.78-.41z" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true">
              <rect x="1.5" y="1" width="2.6" height="8" rx="0.8" />
              <rect x="5.9" y="1" width="2.6" height="8" rx="0.8" />
            </svg>
          )}
        </button>
      )}

      {/* Word tooltip — DOM overlay, pinned to the hovered node. */}
      <div
        ref={tipRef}
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0 z-10 flex items-center gap-1.5 rounded-lg border border-white/10 bg-[#0c0c16]/90 px-2.5 py-1.5 text-[11px] font-medium text-white/90 opacity-0 shadow-lg backdrop-blur-sm transition-opacity duration-150"
      >
        <span className="lf-dot h-1.5 w-1.5 rounded-full" style={{ background: "#fff" }} />
        <span className="lf-word" />
        <span className="lf-meta font-mono text-[10px] text-white/50" />
      </div>

      <span className="sr-only">
        Decorative animated voice constellation: four speakers' words as glowing nodes across a dark field.
      </span>
    </div>
  );
  }
);

export default ListeningField;
