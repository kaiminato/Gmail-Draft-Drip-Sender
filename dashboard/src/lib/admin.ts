import { redirect } from "next/navigation";
import { auth } from "@/auth";

export type AdminSession = { email: string | null; method: "google" | "password" };

// Every page and server action goes through this. There is no middleware:
// guarding at the data boundary is what actually protects the data.
export async function requireAdmin(): Promise<AdminSession> {
  const session = await auth();
  if (!session?.isAdmin) redirect("/login");
  return { email: session.user?.email ?? null, method: session.method === "google" ? "google" : "password" };
}

// Changing the password or the allow-list needs a Google-verified identity,
// so a leaked password can never be used to lock the real admins out.
export async function requireGoogleAdmin(): Promise<AdminSession> {
  const s = await requireAdmin();
  if (s.method !== "google") redirect("/settings?denied=1");
  return s;
}

export async function currentAdmin(): Promise<AdminSession | null> {
  const session = await auth();
  if (!session?.isAdmin) return null;
  return { email: session.user?.email ?? null, method: session.method === "google" ? "google" : "password" };
}
