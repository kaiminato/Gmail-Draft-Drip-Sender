import { redirect } from "next/navigation";
import { auth, isAdminEmail } from "@/auth";

// Every page and server action goes through this. There is no middleware:
// guarding at the data boundary is what actually protects the data.
export async function requireAdmin() {
  const session = await auth();
  const email = session?.user?.email;
  if (!session || !isAdminEmail(email)) {
    redirect("/login");
  }
  return { email: email as string };
}

export async function isSignedInAdmin(): Promise<boolean> {
  const session = await auth();
  return !!session && isAdminEmail(session.user?.email);
}
