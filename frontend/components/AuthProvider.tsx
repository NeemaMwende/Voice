"use client";

import { SessionProvider } from "next-auth/react";

/**
 * Client bridge so components can use useSession()/signIn()/signOut().
 * The server layout passes the initial session for SSR.
 */
export default function AuthProvider({
  children,
  session,
}: {
  children: React.ReactNode;
  session?: unknown;
}) {
  return <SessionProvider session={session as never}>{children}</SessionProvider>;
}
