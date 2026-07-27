export type NoteSection = { heading: string; body?: string; bullets?: string[] };

export type Speaker = {
  id: string;
  name: string;
  /** hex accent used for the avatar + name */
  color: string;
};

export type Segment = {
  speakerId: string;
  /** start offset in seconds */
  tSec: number;
  /** exactly what was said — fillers, stutters, background noise */
  raw: string;
  /** the same turn after noise + filler removal */
  clean: string;
};

export type DemoContent = {
  title: string;
  transcript: string;
  speakers: Speaker[];
  segments: Segment[];
  summary: NoteSection[];
  key: string[];
  tags: string[];
  durationSec: number;
};

const C = {
  violet: "#7c5cff",
  cyan: "#00e5ff",
  pink: "#ff4ecd",
  green: "#2ee6a6",
  amber: "#ffb454",
};

export const DEMOS: DemoContent[] = [
  {
    title: "Q3 Launch Sync",
    durationSec: 742,
    speakers: [
      { id: "alex", name: "Alex Rivera", color: C.violet },
      { id: "sarah", name: "Sarah Chen", color: C.cyan },
      { id: "marcus", name: "Marcus Bell", color: C.pink },
    ],
    segments: [
      {
        speakerId: "alex",
        tSec: 4,
        raw: "Alright, um, alright everyone, thanks — thanks for jumping on. So yeah let's, let's do a quick sync on the Q3 launch. [keyboard clatter]",
        clean: "Alright everyone, thanks for jumping on. Let's do a quick sync on the Q3 launch.",
      },
      {
        speakerId: "sarah",
        tSec: 21,
        raw: "Yeah so on engineering, uh, the new onboarding flow is like code complete, we're basically just waiting on QA to sign off, so probably, you know, Thursday-ish.",
        clean: "On engineering, the new onboarding flow is code complete; we're just waiting on QA to sign off, probably Thursday.",
      },
      {
        speakerId: "alex",
        tSec: 48,
        raw: "Cool, cool. Marcus, where are we, um, where are we on the campaign assets?",
        clean: "Marcus, where are we on the campaign assets?",
      },
      {
        speakerId: "marcus",
        tSec: 63,
        raw: "Good, good — so the landing page copy is done, we just, we just need final design review. [door closes] Sorry. And, and on budget we're tracking like eight percent under, which uh gives us room for the paid social push.",
        clean: "The landing page copy is done — we just need final design review. On budget we're tracking about eight percent under, which gives us room for the paid social push.",
      },
      {
        speakerId: "alex",
        tSec: 118,
        raw: "Okay perfect. Two blockers I, I wanna flag. So the analytics integration is still, it's still pending vendor access, and then we need legal to review the new terms before we, before we ship. Let's, let's aim to close both by end of week.",
        clean: "Two blockers I want to flag: the analytics integration is still pending vendor access, and we need legal to review the new terms before we ship. Let's aim to close both by end of week.",
      },
      {
        speakerId: "alex",
        tSec: 176,
        raw: "So action items — Sarah, you own QA sign-off, um, Marcus you follow up with the vendor, and I'll, I'll chase legal. Sound good? Great.",
        clean: "Action items: Sarah owns QA sign-off, Marcus follows up with the vendor, and I'll chase legal.",
      },
    ],
    transcript:
      "Alright everyone, thanks for jumping on. Let's do a quick sync on the Q3 launch. First, engineering — the new onboarding flow is code complete, we're just waiting on QA to sign off, probably Thursday. Marketing, where are we on the campaign assets? Good, the landing page copy is done, we just need final design review. On budget: we're tracking about eight percent under, which gives us room for the paid social push. Two blockers I want to flag — the analytics integration is still pending vendor access, and we need legal to review the new terms before we ship. Let's aim to close both by end of week. Action items: Sarah owns QA sign-off, Marcus follows up with the vendor, and I'll chase legal.",
    summary: [
      {
        heading: "Overview",
        body: "Team sync on the Q3 product launch covering engineering, marketing, budget and open blockers. Overall on track with a target to resolve remaining blockers by end of week.",
      },
      {
        heading: "Discussion",
        bullets: [
          "Onboarding flow is code-complete; awaiting QA sign-off (expected Thursday).",
          "Landing page copy finished — pending final design review.",
          "Budget tracking ~8% under, freeing spend for paid social.",
        ],
      },
    ],
    key: [
      "QA sign-off — owner: Sarah",
      "Vendor access for analytics — owner: Marcus",
      "Legal review of new terms — owner: host",
      "Target: close all blockers by end of week",
    ],
    tags: ["Meeting", "Product", "Q3 Launch"],
  },
  {
    title: "Product Voice Memo",
    durationSec: 188,
    speakers: [{ id: "me", name: "Voice Memo", color: C.green }],
    segments: [
      {
        speakerId: "me",
        tSec: 2,
        raw: "Hey, um, just recording a few thoughts before I, before I forget. So the user research from last week was, was really interesting.",
        clean: "Just recording a few thoughts before I forget. The user research from last week was really interesting.",
      },
      {
        speakerId: "me",
        tSec: 24,
        raw: "Most people didn't even, like, notice the new filter feature, which tells me the discovery problem is, is kind of bigger than the feature itself. [traffic noise]",
        clean: "Most people didn't even notice the new filter feature, which tells me the discovery problem is bigger than the feature itself.",
      },
      {
        speakerId: "me",
        tSec: 61,
        raw: "I think we should, uh, test surfacing it in the empty state instead of, instead of burying it in settings. Also maybe worth a short tooltip on first use.",
        clean: "I think we should test surfacing it in the empty state instead of burying it in settings. Also worth exploring a short tooltip on first use.",
      },
      {
        speakerId: "me",
        tSec: 118,
        raw: "Second thing — churn seems, seems concentrated in the first seven days, so an onboarding email sequence could, you know, move the needle. Let me sketch that out and share with growth tomorrow.",
        clean: "Second: churn seems concentrated in the first seven days, so an onboarding email sequence could move the needle. Let me sketch that out and share with the growth team tomorrow.",
      },
    ],
    transcript:
      "Hey, just recording a few thoughts before I forget. The user research from last week was really interesting — most people didn't even notice the new filter feature, which tells me the discovery problem is bigger than the feature itself. I think we should test surfacing it in the empty state instead of burying it in settings. Also worth exploring a short tooltip on first use. Second thing: churn seems concentrated in the first seven days, so an onboarding email sequence could move the needle. Let me sketch that out and share with the growth team tomorrow.",
    summary: [
      {
        heading: "Overview",
        body: "Personal voice memo capturing reflections on recent user research and early churn patterns, with proposed experiments.",
      },
      {
        heading: "Ideas",
        bullets: [
          "Surface the filter feature in the empty state rather than settings.",
          "Add a first-use tooltip to aid discovery.",
          "Build a 7-day onboarding email sequence to reduce early churn.",
        ],
      },
    ],
    key: [
      "Filter feature has a discovery problem, not a value problem",
      "Churn concentrated in first 7 days",
      "Draft onboarding email sequence for growth team",
    ],
    tags: ["Voice Memo", "UX Research", "Growth"],
  },
  {
    title: "Podcast — Focus & Systems",
    durationSec: 623,
    speakers: [
      { id: "host", name: "Host", color: C.pink },
      { id: "guest", name: "Guest", color: C.cyan },
    ],
    segments: [
      {
        speakerId: "host",
        tSec: 3,
        raw: "Welcome back to the show. So today we're, we're talking about focus in a, in a distracted world. [intro music fades]",
        clean: "Welcome back to the show. Today we're talking about focus in a distracted world.",
      },
      {
        speakerId: "guest",
        tSec: 22,
        raw: "Yeah, thanks for having me. So my, my argument is that attention is less about willpower and more about, um, environment design.",
        clean: "Thanks for having me. My argument is that attention is less about willpower and more about environment design.",
      },
      {
        speakerId: "guest",
        tSec: 58,
        raw: "The core idea is you don't, you don't rise to the level of your motivation, you kind of fall to the level of your systems.",
        clean: "The core idea: you don't rise to the level of your motivation, you fall to the level of your systems.",
      },
      {
        speakerId: "guest",
        tSec: 96,
        raw: "So instead of trying harder, you just, you remove friction from the good behaviors and add friction to the, to the bad ones. Like, put your phone in another room. Lay out your workout clothes the night before.",
        clean: "So instead of trying harder, remove friction from the good behaviors and add friction to the bad ones. Put your phone in another room. Lay out your workout clothes the night before.",
      },
      {
        speakerId: "host",
        tSec: 152,
        raw: "Right, so small, small architecture changes that just compound over time.",
        clean: "Right — small architecture changes compound into big behavioral shifts over time.",
      },
    ],
    transcript:
      "Welcome back to the show. Today we're talking about focus in a distracted world. My guest argues that attention is less about willpower and more about environment design. The core idea: you don't rise to the level of your motivation, you fall to the level of your systems. So instead of trying harder, remove friction from the good behaviors and add friction to the bad ones. Put your phone in another room. Lay out your workout clothes the night before. Small architecture changes compound into big behavioral shifts over time.",
    summary: [
      {
        heading: "Overview",
        body: "Podcast episode on maintaining focus, arguing that environment design beats willpower for lasting behavior change.",
      },
      {
        heading: "Takeaways",
        bullets: [
          "You fall to the level of your systems, not your motivation.",
          "Remove friction from good habits; add friction to bad ones.",
          "Small environmental tweaks compound over time.",
        ],
      },
    ],
    key: [
      "Design environment over relying on willpower",
      "Reduce friction for desired behaviors",
      "Add friction for undesired behaviors",
      "Small changes compound",
    ],
    tags: ["Podcast", "Productivity", "Habits"],
  },
  {
    title: "Client Discovery Call",
    durationSec: 934,
    speakers: [
      { id: "consultant", name: "You", color: C.violet },
      { id: "client", name: "Client — VP Ops", color: C.amber },
    ],
    segments: [
      {
        speakerId: "consultant",
        tSec: 5,
        raw: "Thanks for, for making the time. So maybe just walk me through your, your current workflow?",
        clean: "Thanks for making the time. Walk me through your current workflow.",
      },
      {
        speakerId: "client",
        tSec: 26,
        raw: "Yeah so right now everything, everything lives in spreadsheets and it just, it doesn't scale. We've got like five people copy-pasting between tools every, every morning. [phone buzzing]",
        clean: "Right now everything lives in spreadsheets and it doesn't scale — we have five people copy-pasting between tools every morning.",
      },
      {
        speakerId: "client",
        tSec: 74,
        raw: "The biggest pain is honestly reporting. Leadership, they want a live view and we just, we can't give it to them.",
        clean: "The biggest pain is reporting; leadership wants a live view and we can't give it to them.",
      },
      {
        speakerId: "consultant",
        tSec: 118,
        raw: "Got it. And, um, on budget and, and decision-making?",
        clean: "Got it. And on budget and decision-making?",
      },
      {
        speakerId: "client",
        tSec: 133,
        raw: "So budget's approved for this quarter, and the, the main decision-maker is the VP of Operations, that's me. Timeline's kind of tight — we'd like something before, before fiscal year close.",
        clean: "Budget is approved for this quarter, and the main decision-maker is the VP of Operations. Timeline is tight — they'd like something in place before the fiscal year close.",
      },
      {
        speakerId: "consultant",
        tSec: 188,
        raw: "Okay, that's, that's really helpful. Let me put together a proposal covering integration, the reporting dashboard, and a, and a rollout plan.",
        clean: "That's really helpful. Let me put together a proposal covering integration, the reporting dashboard, and a rollout plan.",
      },
    ],
    transcript:
      "Thanks for making the time. So walk me through your current workflow. Right now everything lives in spreadsheets and it doesn't scale — we have five people copy-pasting between tools every morning. The biggest pain is reporting; leadership wants a live view and we can't give it to them. Budget is approved for this quarter, and the main decision-maker is the VP of Operations. Timeline is tight — they'd like something in place before the fiscal year close. Okay, that's really helpful. Let me put together a proposal covering integration, the reporting dashboard, and a rollout plan.",
    summary: [
      {
        heading: "Overview",
        body: "Discovery call with a prospective client. Current process is manual and spreadsheet-based; primary pain is real-time reporting for leadership.",
      },
      {
        heading: "Situation",
        bullets: [
          "Five people manually moving data between tools daily.",
          "Leadership wants a live reporting view that isn't possible today.",
          "Budget approved this quarter; VP of Operations is the decision-maker.",
        ],
      },
    ],
    key: [
      "Prepare proposal: integration + reporting dashboard + rollout plan",
      "Decision-maker: VP of Operations",
      "Timeline: before fiscal year close",
      "Budget already approved",
    ],
    tags: ["Sales", "Discovery", "Client"],
  },
];

export function pickDemo(): DemoContent {
  return DEMOS[Math.floor(Math.random() * DEMOS.length)];
}

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
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
 * the fillers / stutters / background noise the model stripped out.
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
