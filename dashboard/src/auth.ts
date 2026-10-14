import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();

export function isAdminEmail(email: string | null | undefined): boolean {
  return !!adminEmail && !!email && email.trim().toLowerCase() === adminEmail;
}

// Google sign-in, but only one address is ever let through. Everyone else
// gets bounced back to the sign-in page with an error.
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    signIn({ profile, user }) {
      return isAdminEmail(profile?.email ?? user?.email);
    },
    jwt({ token }) {
      // Re-check on every request so changing ADMIN_EMAIL locks out old sessions.
      token.isAdmin = isAdminEmail(token.email);
      return token;
    },
    session({ session, token }) {
      (session as typeof session & { isAdmin?: boolean }).isAdmin = token.isAdmin === true;
      return session;
    },
  },
});
