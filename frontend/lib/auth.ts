import type { NextAuthOptions } from "next-auth";
import KeycloakProvider from "next-auth/providers/keycloak";

/**
 * DAXA uses Keycloak as its identity provider (OIDC). This module is the
 * single source of truth for the Auth.js config — used by the API route,
 * the layout (server-side session) and middleware.
 */
export const authOptions: NextAuthOptions = {
  providers: [
    KeycloakProvider({
      clientId: process.env.KEYCLOAK_CLIENT_ID ?? "daxa-web",
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET ?? "",
      issuer: process.env.KEYCLOAK_ISSUER ?? "http://localhost:8080/realms/daxa",
    }),
  ],
  session: { strategy: "jwt" },
  secret: process.env.NEXTAUTH_SECRET,
  callbacks: {
    // Carry the Keycloak access token so the frontend can call the DAXA API
    // with it (the backend validates these against the realm's JWKS).
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.idToken = account.id_token;
      }
      return token;
    },
    async session({ session, token }) {
      if (token) {
        session.accessToken = token.accessToken as string | undefined;
      }
      return session;
    },
  },
};
