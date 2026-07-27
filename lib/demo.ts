export type NoteSection = { heading: string; body?: string; bullets?: string[] };

export type DemoContent = {
  title: string;
  transcript: string;
  summary: NoteSection[];
  key: string[];
  tags: string[];
  durationSec: number;
};

export const DEMOS: DemoContent[] = [
  {
    title: "Q3 Launch Sync",
    durationSec: 742,
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

export function fmtSize(bytes: number): string {
  return bytes < 1e6 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}
