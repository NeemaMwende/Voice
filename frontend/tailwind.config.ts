import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Surfaces flip with the data-theme attribute (see globals.css).
        bg: "var(--bg-base)",
        panel: "var(--panel)",
        // Accent tokens read RGB channels from CSS vars so the Settings page
        // can re-theme them at runtime AND opacity modifiers (neon2/10) work.
        neon: "rgb(var(--neon) / <alpha-value>)",
        neon2: "rgb(var(--neon2) / <alpha-value>)",
        neon3: "rgb(var(--neon3) / <alpha-value>)",
        fg: "rgb(var(--fg) / <alpha-value>)",
        muted: "var(--muted)",
        overlay: "rgb(var(--overlay) / <alpha-value>)",
        bar: "rgb(var(--bar) / <alpha-value>)",
        toast: "var(--toast)",
        ok: "#2ee6a6",
      },
      boxShadow: {
        card: "0 20px 60px -20px rgba(0,0,0,0.8)",
      },
      keyframes: {
        pulse2: {
          "0%": { boxShadow: "0 0 0 0 rgba(124,92,255,0.55)" },
          "70%": { boxShadow: "0 0 0 22px rgba(124,92,255,0)" },
          "100%": { boxShadow: "0 0 0 0 rgba(124,92,255,0)" },
        },
        bar: {
          "0%,100%": { height: "8px" },
          "50%": { height: "44px" },
        },
        flow: { to: { backgroundPosition: "200% 0" } },
        float: {
          "0%,100%": { transform: "translate(0,0) scale(1)" },
          "50%": { transform: "translate(30px,-30px) scale(1.1)" },
        },
        fade: {
          from: { opacity: "0", transform: "translateY(8px)" },
          to: { opacity: "1", transform: "none" },
        },
      },
      animation: {
        pulse2: "pulse2 2.4s infinite",
        bar: "bar 1s ease-in-out infinite",
        flow: "flow 2s linear infinite",
        float: "float 14s ease-in-out infinite",
        fade: "fade 0.45s ease",
      },
    },
  },
  plugins: [],
};

export default config;
