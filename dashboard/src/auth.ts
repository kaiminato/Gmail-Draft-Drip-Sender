import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import Google from "next-auth/providers/google";
import { isAllowedGoogleEmail, verifyAdminPassword } from "@/lib/admins";

// Two ways in: a Google account on the allow-list, or the shared admin
// password. Either gives a full admin session; only Google sessions may
// change the password or the allow-list (see lib/admin.ts).
export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google,
    Credentials({
      id: "password",
      name: "Password",
      credentials: { password: { label: "Password", type: "password" } },
      async authorize(credentials) {
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (!(await verifyAdminPassword(password))) return null;
        return { id: "admin-password", name: "Admin", email: null };
      },
    }),
  ],
  session: { strategy: "jwt" },
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    async signIn({ account, profile, user }) {
      if (account?.provider === "google") {
        return isAllowedGoogleEmail(profile?.email ?? user?.email);
      }
      // The password provider already verified the secret in authorize().
      return account?.provider === "password";
    },
    jwt({ token, account }) {
      if (account) {
        token.isAdmin = true;
        token.method = account.provider === "google" ? "google" : "password";
      }
      return token;
    },
    session({ session, token }) {
      session.isAdmin = token.isAdmin === true;
      session.method = token.method;
      return session;
    },
  },
});
