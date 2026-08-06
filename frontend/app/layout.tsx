import type { Metadata } from "next";
import "./globals.css";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import AuthProvider from "@/components/AuthProvider";
import { AppProvider } from "@/context/AppContext";
import { ThemeProvider, NO_FLASH_SCRIPT } from "@/context/ThemeContext";
import Shell from "@/components/Shell";
import Background from "@/components/Background";
import Toaster from "@/components/Toast";

export const metadata: Metadata = {
  title: "DAXA — Audio to Notes",
  description: "Upload audio, transcribe it, and generate smart notes.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply saved theme before first paint to avoid a flash of default theme. */}
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          <AuthProvider session={session}>
            <AppProvider>
              <Background />
              <Shell>{children}</Shell>
              <Toaster />
            </AppProvider>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
