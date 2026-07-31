import type { Metadata } from "next";
import "./globals.css";
import { AppProvider } from "@/context/AppContext";
import { ThemeProvider, NO_FLASH_SCRIPT } from "@/context/ThemeContext";
import Shell from "@/components/Shell";
import Background from "@/components/Background";
import Toaster from "@/components/Toast";

export const metadata: Metadata = {
  title: "EchoNotes — Audio to Notes",
  description: "Upload audio, transcribe it, and generate smart notes.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply saved theme before first paint to avoid a flash of default theme. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <AppProvider>
            <Background />
            <Shell>{children}</Shell>
            <Toaster />
          </AppProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
