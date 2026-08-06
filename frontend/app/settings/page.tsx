"use client";

import PageHeader from "@/components/PageHeader";
import { useTheme, ACCENTS, AccentName, Mode } from "@/context/ThemeContext";
import { IconSun, IconMoon } from "@/components/icons";

export default function SettingsPage() {
  const { accent, mode, setAccent, setMode } = useTheme();

  return (
    <div>
      <PageHeader title="Settings" subtitle="Personalize how Voice looks." />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Accent color */}
        <div className="rounded-3xl border border-overlay/[0.08] bg-panel backdrop-blur-xl shadow-card p-7">
          <h2 className="text-[15px] font-semibold mb-1">Accent color</h2>
          <p className="text-[12.5px] text-muted mb-5">
            Sets the app&apos;s highlight color — buttons, active items, and playback highlights.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(Object.keys(ACCENTS) as AccentName[]).map((name) => {
              const a = ACCENTS[name];
              const selected = accent === name;
              return (
                <button
                  key={name}
                  onClick={() => setAccent(name)}
                  aria-pressed={selected}
                  className={`flex items-center gap-3 rounded-2xl border p-3.5 text-left transition-all ${
                    selected
                      ? "border-neon/70 bg-neon/10 shadow-[0_8px_24px_-10px_rgb(var(--neon))]"
                      : "border-overlay/[0.08] bg-overlay/[0.03] hover:bg-overlay/[0.06]"
                  }`}
                >
                  {/* triad swatch */}
                  <span className="flex shrink-0 -space-x-1.5">
                    {a.hex.map((c, i) => (
                      <span
                        key={i}
                        className="h-6 w-6 rounded-full border-2 border-black/30"
                        style={{ background: c }}
                      />
                    ))}
                  </span>
                  <span className="flex-1 text-[13.5px] font-semibold">{a.label}</span>
                  {selected && (
                    <span className="text-[11px] font-semibold text-neon2">Active</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Appearance / mode */}
        <div className="rounded-3xl border border-overlay/[0.08] bg-panel backdrop-blur-xl shadow-card p-7">
          <h2 className="text-[15px] font-semibold mb-1">Appearance</h2>
          <p className="text-[12.5px] text-muted mb-5">Switch between dark and light.</p>

          <div className="flex gap-3">
            {(
              [
                { m: "dark" as Mode, label: "Dark", Icon: IconMoon },
                { m: "light" as Mode, label: "Light", Icon: IconSun },
              ]
            ).map(({ m, label, Icon }) => {
              const selected = mode === m;
              return (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  aria-pressed={selected}
                  className={`flex flex-1 items-center justify-center gap-2.5 rounded-2xl border py-4 text-[13.5px] font-semibold transition-all ${
                    selected
                      ? "border-transparent bg-gradient-to-br from-neon to-neon2 text-white"
                      : "border-overlay/[0.08] bg-overlay/[0.03] text-muted hover:text-fg hover:bg-overlay/[0.06]"
                  }`}
                >
                  <Icon className="h-4 w-4" /> {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
