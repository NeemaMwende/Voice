import type { Metadata } from "next";
import "./globals.css";
import { AppProvider } from "@/context/AppContext";
import Sidebar from "@/components/Sidebar";
import Background from "@/components/Background";
import Toaster from "@/components/Toast";

export const metadata: Metadata = {
  title: "EchoNotes — Audio to Notes",
  description: "Upload audio, transcribe it, and generate smart notes.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppProvider>
          <Background />
          <div className="relative z-10 flex">
            <Sidebar />
            <main className="flex-1 min-w-0 min-h-screen px-8 py-8">{children}</main>
          </div>
          <Toaster />
        </AppProvider>
      </body>
    </html>
  );
}
