"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { isTier, type Tier } from "@/lib/tiers";

function refresh() {
  revalidatePath("/", "layout");
}

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
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

type Command = { type: "start"; tier: Tier } | { type: "stop" };

function parseAction(action: string): Command | null {
  if (action === "stop") return { type: "stop" };
  const m = /^start:(\w+)$/.exec(action);
  if (m && isTier(m[1])) return { type: "start", tier: m[1] };
  return null;
}

// Queues a command for a set of accounts in one statement. Each account gets
// its own command id so its ack can be matched.
async function queueFor(ids: string[], cmd: Command) {
  if (!ids.length) return;
  // A fresh id per row: generate them client-side and update in one go using
  // a VALUES list joined on id.
  const pairs = ids.map((id) => ({ id, cid: randomUUID() }));
  const values = sql.join(
    pairs.map((p) => sql`(${p.id}::uuid, ${p.cid})`),
    sql`, `,
  );
  await db.execute(sql`
    update accounts a
    set pending_command = ${cmd.type},
        pending_command_id = v.cid,
        pending_tier = ${cmd.type === "start" ? cmd.tier : null},
        pending_command_at = now()
    from (values ${values}) as v(id, cid)
    where a.id = v.id
  `);
}

// One account, from its row or its page.
export async function queueCommand(form: FormData) {
  await requireAdmin();
  const accountId = str(form, "accountId");
  const cmd = parseAction(str(form, "action"));
  if (!accountId || !cmd) return;
  await queueFor([accountId], cmd);
  refresh();
}

// The bulk bar: ticked rows, or (with none ticked) every account in the
// current manager filter.
export async function bulkAct(form: FormData) {
  await requireAdmin();
  const cmd = parseAction(str(form, "action"));
  if (!cmd) return;
  let ids = form.getAll("ids").filter((v): v is string => typeof v === "string" && v.length > 0);
  if (!ids.length) {
    const filter = str(form, "managerId");
    const where = filter === "none" ? isNull(schema.accounts.managerId) : filter ? eq(schema.accounts.managerId, filter) : undefined;
    const rows = await db.select({ id: schema.accounts.id }).from(schema.accounts).where(where);
    ids = rows.map((r) => r.id);
  }
  await queueFor(ids, cmd);
  refresh();
}

export async function cancelCommand(form: FormData) {
  await requireAdmin();
  const accountId = str(form, "accountId");
  if (!accountId) return;
  await db
    .update(schema.accounts)
    .set({ pendingCommand: null, pendingCommandId: null, pendingTier: null, pendingCommandAt: null })
    .where(eq(schema.accounts.id, accountId));
  refresh();
}

export async function deleteAccount(form: FormData) {
  await requireAdmin();
  const accountId = str(form, "accountId");
  if (!accountId) return;
  // Events cascade. The extension will re-register itself on its next beat if
  // it is still alive, with a fresh row.
  await db.delete(schema.accounts).where(eq(schema.accounts.id, accountId));
  refresh();
}

export async function deleteAccounts(form: FormData) {
  await requireAdmin();
  const ids = form.getAll("ids").filter((v): v is string => typeof v === "string" && v.length > 0);
  if (!ids.length) return;
  await db.delete(schema.accounts).where(inArray(schema.accounts.id, ids));
  refresh();
}
