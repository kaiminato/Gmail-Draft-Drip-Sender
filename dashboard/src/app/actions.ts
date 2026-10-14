"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin";

function refresh() {
  revalidatePath("/", "layout");
}

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function num(form: FormData, key: string): number {
  return Number(str(form, key));
}

/* ---------- managers ---------- */

export async function createManager(form: FormData) {
  await requireAdmin();
  const name = str(form, "name").slice(0, 100);
  if (!name) return;
  await db.insert(schema.managers).values({ name });
  refresh();
}

export async function renameManager(form: FormData) {
  await requireAdmin();
  const id = str(form, "id");
  const name = str(form, "name").slice(0, 100);
  if (!id || !name) return;
  await db.update(schema.managers).set({ name }).where(eq(schema.managers.id, id));
  refresh();
}

export async function deleteManager(form: FormData) {
  await requireAdmin();
  const id = str(form, "id");
  if (!id) return;
  // accounts.managerId is ON DELETE SET NULL, so the accounts stay.
  await db.delete(schema.managers).where(eq(schema.managers.id, id));
  refresh();
}

/* ---------- accounts ---------- */

export async function setManager(form: FormData) {
  await requireAdmin();
  const accountId = str(form, "accountId");
  const managerId = str(form, "managerId") || null;
  if (!accountId) return;
  await db.update(schema.accounts).set({ managerId }).where(eq(schema.accounts.id, accountId));
  refresh();
}

export async function setInterval(form: FormData) {
  await requireAdmin();
  const accountId = str(form, "accountId");
  let min = num(form, "minMinutes");
  let max = num(form, "maxMinutes");
  if (!accountId || !Number.isFinite(min) || !Number.isFinite(max)) return;
  min = Math.min(1440, Math.max(0.5, min));
  max = Math.min(1440, Math.max(0.5, max));
  if (min > max) [min, max] = [max, min];
  await db
    .update(schema.accounts)
    .set({ minMinutes: min, maxMinutes: max })
    .where(eq(schema.accounts.id, accountId));
  refresh();
}

export async function setDailyLimit(form: FormData) {
  await requireAdmin();
  const accountId = str(form, "accountId");
  const cap = num(form, "dailyLimit");
  if (!accountId || !Number.isFinite(cap)) return;
  await db
    .update(schema.accounts)
    .set({ dailyLimit: Math.min(2000, Math.max(0, Math.floor(cap))) })
    .where(eq(schema.accounts.id, accountId));
  refresh();
}

// Applies one interval + cap to every account, or every account under one
// manager. Handy when a whole team's pacing changes at once.
export async function setSettingsBulk(form: FormData) {
  await requireAdmin();
  const managerId = str(form, "managerId");
  let min = num(form, "minMinutes");
  let max = num(form, "maxMinutes");
  const cap = num(form, "dailyLimit");
  if (![min, max, cap].every(Number.isFinite)) return;
  min = Math.min(1440, Math.max(0.5, min));
  max = Math.min(1440, Math.max(0.5, max));
  if (min > max) [min, max] = [max, min];
  const set = { minMinutes: min, maxMinutes: max, dailyLimit: Math.min(2000, Math.max(0, Math.floor(cap))) };
  if (managerId) {
    await db.update(schema.accounts).set(set).where(eq(schema.accounts.managerId, managerId));
  } else {
    await db.update(schema.accounts).set(set);
  }
  refresh();
}

export async function queueCommand(form: FormData) {
  await requireAdmin();
  const accountId = str(form, "accountId");
  const type = str(form, "type");
  if (!accountId || (type !== "start" && type !== "stop")) return;
  await db
    .update(schema.accounts)
    .set({ pendingCommand: type, pendingCommandId: randomUUID(), pendingCommandAt: new Date() })
    .where(eq(schema.accounts.id, accountId));
  refresh();
}

export async function cancelCommand(form: FormData) {
  await requireAdmin();
  const accountId = str(form, "accountId");
  if (!accountId) return;
  await db
    .update(schema.accounts)
    .set({ pendingCommand: null, pendingCommandId: null, pendingCommandAt: null })
    .where(eq(schema.accounts.id, accountId));
  refresh();
}

// Start or stop every account under a manager (or all of them).
export async function queueCommandBulk(form: FormData) {
  await requireAdmin();
  const managerId = str(form, "managerId");
  const type = str(form, "type");
  if (type !== "start" && type !== "stop") return;
  const targets = managerId
    ? await db.select({ id: schema.accounts.id }).from(schema.accounts).where(eq(schema.accounts.managerId, managerId))
    : await db.select({ id: schema.accounts.id }).from(schema.accounts);
  for (const t of targets) {
    await db
      .update(schema.accounts)
      .set({ pendingCommand: type, pendingCommandId: randomUUID(), pendingCommandAt: new Date() })
      .where(eq(schema.accounts.id, t.id));
  }
  refresh();
}

export async function deleteAccount(form: FormData) {
  await requireAdmin();
  const accountId = str(form, "accountId");
  if (!accountId) return;
  // Events cascade. The extension will re-register itself on its next beat if
  // it is still alive, with a fresh row and default settings.
  await db.delete(schema.accounts).where(eq(schema.accounts.id, accountId));
  refresh();
}
