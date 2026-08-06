"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";

export type AccentName = "violet" | "ocean" | "sunset" | "emerald" | "rose";
export type Mode = "dark" | "light";

/** Each accent is a triad of RGB channels matching --neon / --neon2 / --neon3.
 *  `hex` values are only for rendering preview swatches in the UI. */
export const ACCENTS: Record<
  AccentName,
  { label: string; neon: string; neon2: string; neon3: string; hex: [string, string, string] }
> = {
  violet: { label: "Violet", neon: "124 92 255", neon2: "0 229 255", neon3: "255 78 205", hex: ["#7c5cff", "#00e5ff", "#ff4ecd"] },
  ocean: { label: "Ocean", neon: "56 132 255", neon2: "0 214 200", neon3: "94 200 255", hex: ["#3884ff", "#00d6c8", "#5ec8ff"] },
  sunset: { label: "Sunset", neon: "255 122 69", neon2: "255 78 141", neon3: "255 189 89", hex: ["#ff7a45", "#ff4e8d", "#ffbd59"] },
  emerald: { label: "Emerald", neon: "46 214 140", neon2: "0 229 255", neon3: "124 220 120", hex: ["#2ed68c", "#00e5ff", "#7cdc78"] },
  rose: { label: "Rose", neon: "255 82 129", neon2: "196 122 255", neon3: "255 138 190", hex: ["#ff5281", "#c47aff", "#ff8abe"] },
};

const STORAGE_MODE = "voice.mode";
const STORAGE_ACCENT = "voice.accent";
const STORAGE_VARS = "voice.vars";

function applyAccent(name: AccentName) {
  const a = ACCENTS[name];
  const root = document.documentElement;
  root.style.setProperty("--neon", a.neon);
  root.style.setProperty("--neon2", a.neon2);
  root.style.setProperty("--neon3", a.neon3);
  localStorage.setItem(STORAGE_ACCENT, name);
  localStorage.setItem(STORAGE_VARS, JSON.stringify({ neon: a.neon, neon2: a.neon2, neon3: a.neon3 }));
}

function applyMode(mode: Mode) {
  document.documentElement.setAttribute("data-theme", mode);
  localStorage.setItem(STORAGE_MODE, mode);
}

type ThemeState = {
  accent: AccentName;
  mode: Mode;
  setAccent: (a: AccentName) => void;
  setMode: (m: Mode) => void;
};

const ThemeContext = createContext<ThemeState | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [accent, setAccentState] = useState<AccentName>("violet");
  const [mode, setModeState] = useState<Mode>("dark");

  // Hydrate from localStorage once on mount (the no-flash script in layout has
  // already applied these to <html>; this just syncs React state to match).
  useEffect(() => {
    const storedAccent = (localStorage.getItem(STORAGE_ACCENT) as AccentName) || "violet";
    const storedMode = (localStorage.getItem(STORAGE_MODE) as Mode) || "dark";
    if (ACCENTS[storedAccent]) setAccentState(storedAccent);
    setModeState(storedMode === "light" ? "light" : "dark");
  }, []);

  const setAccent = (a: AccentName) => {
    setAccentState(a);
    applyAccent(a);
  };
  const setMode = (m: Mode) => {
    setModeState(m);
    applyMode(m);
  };

  return (
    <ThemeContext.Provider value={{ accent, mode, setAccent, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

/** Inline script injected in <head> to apply the saved theme before first
 *  paint, preventing a flash of the default (dark/violet) theme on reload. */
export const NO_FLASH_SCRIPT = `(function(){try{
var m=localStorage.getItem('${STORAGE_MODE}')||'dark';
document.documentElement.setAttribute('data-theme',m);
var v=localStorage.getItem('${STORAGE_VARS}');
if(v){v=JSON.parse(v);var r=document.documentElement.style;
r.setProperty('--neon',v.neon);r.setProperty('--neon2',v.neon2);r.setProperty('--neon3',v.neon3);}
}catch(e){}})();`;
