"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireGoogleAdmin } from "@/lib/admin";
import { addAdminEmail, isBuiltinAdmin, passwordProblem, removeAdminEmail, setAdminPassword } from "@/lib/admins";

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function changePassword(form: FormData) {
  await requireGoogleAdmin();
  const next = typeof form.get("password") === "string" ? (form.get("password") as string) : "";
  const again = typeof form.get("confirm") === "string" ? (form.get("confirm") as string) : "";
  const problem = passwordProblem(next) ?? (next !== again ? "The two entries do not match." : null);
  if (problem) redirect("/settings?error=" + encodeURIComponent(problem));
  await setAdminPassword(next);
  revalidatePath("/settings");
  redirect("/settings?ok=password");
}

export async function addAdmin(form: FormData) {
  const me = await requireGoogleAdmin();
  const email = str(form, "email");
  if (!email) return;
  await addAdminEmail(email, me.email);
  revalidatePath("/settings");
}

export async function removeAdmin(form: FormData) {
  await requireGoogleAdmin();
  const email = str(form, "email");
  if (!email || isBuiltinAdmin(email)) return;
  await removeAdminEmail(email);
  revalidatePath("/settings");
}
