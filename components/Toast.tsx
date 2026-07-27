"use client";

import { useEffect, useState } from "react";

export function toast(message: string) {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("echo-toast", { detail: message }));
  }
}

export default function Toaster() {
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const handler = (e: Event) => {
      setMsg((e as CustomEvent<string>).detail);
      clearTimeout(timer);
      timer = setTimeout(() => setMsg(null), 2600);
    };
    window.addEventListener("echo-toast", handler);
    return () => {
      window.removeEventListener("echo-toast", handler);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div
      className={`fixed bottom-6 left-1/2 z-50 flex items-center gap-2.5 rounded-xl border border-white/10 bg-[#141428]/95 px-5 py-3 text-sm shadow-card transition-all duration-300 ${
        msg ? "translate-y-0 opacity-100" : "translate-y-24 opacity-0"
      }`}
      style={{ transform: `translateX(-50%) ${msg ? "translateY(0)" : "translateY(6rem)"}` }}
    >
      <span className="h-2 w-2 rounded-full bg-ok shadow-[0_0_10px_#2ee6a6]" />
      <span>{msg}</span>
    </div>
  );
}
