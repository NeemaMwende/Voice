import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

// Guard every route except auth entry points, the auth API and static assets.
export default withAuth(
  function middleware() {
    return NextResponse.next();
  },
  {
    pages: { signIn: "/login" },
    callbacks: {
      authorized: ({ token }) => !!token,
    },
  }
);

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.png|api/auth|login|signup).*)",
  ],
};
