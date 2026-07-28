"use client";

import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { NoteContent } from "@/lib/notes";

export type Recording = NoteContent & {
  id: string;
  fileName: string;
  sizeBytes: number;
  createdAt: number;
  audioUrl?: string;
};

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:8000";

type AppState = {
  recordings: Recording[];
  loading: boolean;
  addRecording: (r: Recording) => void;
  removeRecording: (id: string) => void;
};

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);

  // Load persisted recordings from the backend on first mount so a page reload
  // doesn't wipe the workspace.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_URL}/recordings`);
        if (!res.ok) throw new Error(`list failed (${res.status})`);
        const data: Recording[] = await res.json();
        if (!cancelled) setRecordings(data);
      } catch (err) {
        console.error("Could not load saved recordings:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Optimistic add — show it immediately, persist in the background.
  const addRecording = (r: Recording) => {
    setRecordings((prev) => [r, ...prev.filter((x) => x.id !== r.id)]);
    fetch(`${API_URL}/recordings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(r),
    }).catch((err) => console.error("Could not save recording:", err));
  };

  // Optimistic remove — drop it locally, then delete on the server.
  const removeRecording = (id: string) => {
    setRecordings((prev) => prev.filter((x) => x.id !== id));
    fetch(`${API_URL}/recordings/${id}`, { method: "DELETE" }).catch((err) =>
      console.error("Could not delete recording:", err)
    );
  };

  return (
    <AppContext.Provider value={{ recordings, loading, addRecording, removeRecording }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
