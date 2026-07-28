"use client";

import { createContext, useContext, useState, ReactNode } from "react";
import { NoteContent } from "@/lib/notes";

export type Recording = NoteContent & {
  id: string;
  fileName: string;
  sizeBytes: number;
  createdAt: number;
  audioUrl?: string;
};

type AppState = {
  recordings: Recording[];
  addRecording: (r: Recording) => void;
  removeRecording: (id: string) => void;
};

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [recordings, setRecordings] = useState<Recording[]>([]);

  const addRecording = (r: Recording) => setRecordings((prev) => [r, ...prev]);
  const removeRecording = (id: string) =>
    setRecordings((prev) => prev.filter((x) => x.id !== id));

  return (
    <AppContext.Provider value={{ recordings, addRecording, removeRecording }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
