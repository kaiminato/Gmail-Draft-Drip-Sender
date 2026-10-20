import { NextResponse } from "next/server";
import { and, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { heartbeatSchema, type HeartbeatEvent, type HeartbeatReply } from "@/lib/heartbeat";
import { OFFLINE_AFTER_MS } from "@/lib/status";
import { isTier } from "@/lib/tiers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The extension's service worker calls this from a chrome-extension:// origin.
// The key is a bearer header, not a cookie, so a wildcard origin gives away
// nothing.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: CORS });
}

export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

function authorized(req: Request): boolean {
  const key = process.env.EXTENSION_API_KEY;
  if (!key) return false;
  const header = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return !!m && m[1].trim() === key;
}

function toEventRow(accountId: string, e: HeartbeatEvent) {
  const recipient =
    (e.recipients && e.recipients.length ? e.recipients.join(", ") : e.from) || null;
  const reason = e.reason || e.code || (e.type === "started" ? [e.source, e.tier].filter(Boolean).join(" · ") : null) || null;
  let message = e.message || null;
  if (!message && e.subjects && e.subjects.length) message = e.subjects.join(" | ");
  if (e.type === "sent" && e.late) message = (message ? message + " " : "") + "(confirmed late)";
  return {
    id: e.id,
    accountId,
    type: e.type,
    reason,
    subject: e.subject ? e.subject.slice(0, 500) : null,
    recipient: recipient ? recipient.slice(0, 1000) : null,
    message: message ? message.slice(0, 2000) : null,
    occurredAt: new Date(Number.isFinite(e.t) ? e.t : Date.now()),
  };
}

export async function POST(req: Request) {
  if (!authorized(req)) return json({ ok: false, error: "unauthorized" }, 401);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  const parsed = heartbeatSchema.safeParse(raw);
  if (!parsed.success) {
    return json({ ok: false, error: "bad request", issues: parsed.error.issues.slice(0, 5) }, 400);
  }
  const hb = parsed.data;
  const now = new Date();

  // Upsert the account by device id. The extension is the source of truth
  // for everything it reports, including the tier it is running on.
  const reported = {
    email: hb.email ? hb.email.toLowerCase() : null,
    version: hb.version ?? null,
    running: hb.running ?? false,
    busy: hb.busy ?? false,
    stopReason: hb.stopReason || null,
    gmailTabOpen: hb.gmailTabOpen ?? false,
    tier: hb.tier ?? "normal",
    tierSetAt: hb.tierSetAt ? new Date(hb.tierSetAt) : null,
    dayTarget: hb.dayTarget ?? null,
    plannedLeft: hb.plannedLeft ?? null,
    restStart: hb.restStart || null,
    restEnd: hb.restEnd || null,
    nextSendAt: hb.nextSendAt ? new Date(hb.nextSendAt) : null,
    lastSendAt: hb.lastSendAt ? new Date(hb.lastSendAt) : null,
    remainingBucket: hb.remainingBucket ?? "unknown",
    remainingCount: hb.remainingCount ?? null,
    sentToday: hb.sentToday ?? 0,
    totalSent: hb.totalSent ?? 0,
    bounceCount: hb.bounceCount ?? 0,
    consecutiveFailures: hb.consecutiveFailures ?? 0,
    lastSeenAt: now,
  };

  const [account] = await db
    .insert(schema.accounts)
    .values({ deviceId: hb.deviceId, ...reported })
    .onConflictDoUpdate({
      target: schema.accounts.deviceId,
      set: {
        ...reported,
        // Never erase an address we already know because one beat lacked it.
        email: sql`coalesce(${reported.email}, ${schema.accounts.email})`,
      },
    })
    .returning();

  // A reinstall gets a fresh device id, so the same address turns up twice:
  // the old install's row falls silent while the new one reports. Once a
  // twin has been quiet past the offline threshold, fold it into the live
  // row: its events move over (the statistics follow), its manager is kept
  // when the live row has none, its blocks are added, and the row goes. Two
  // installs that both keep reporting are left alone.
  if (account.email) {
    const silentTwins = await db
      .select({ id: schema.accounts.id, managerId: schema.accounts.managerId, blockCount: schema.accounts.blockCount })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.email, account.email),
          ne(schema.accounts.id, account.id),
          or(isNull(schema.accounts.lastSeenAt), lt(schema.accounts.lastSeenAt, new Date(now.getTime() - OFFLINE_AFTER_MS))),
        ),
      );
    for (const twin of silentTwins) {
      await db.update(schema.events).set({ accountId: account.id }).where(eq(schema.events.accountId, twin.id));
      await db.update(schema.sentMail).set({ accountId: account.id }).where(eq(schema.sentMail.accountId, twin.id));
      await db
        .update(schema.accounts)
        .set({
          managerId: account.managerId ?? twin.managerId,
          blockCount: sql`${schema.accounts.blockCount} + ${twin.blockCount}`,
        })
        .where(eq(schema.accounts.id, account.id));
      await db.delete(schema.accounts).where(eq(schema.accounts.id, twin.id));
    }
  }

  // Events: inserted once each, by the id the extension generated.
  const incoming = hb.events ?? [];
  if (incoming.length) {
    const rows = incoming.map((e) => toEventRow(account.id, e));
    const inserted = await db
      .insert(schema.events)
      .values(rows)
      .onConflictDoNothing({ target: schema.events.id })
      .returning({ id: schema.events.id, type: schema.events.type });

    // The sent-mail log: one row per message, with the sender, manager and
    // tier as they are right now. Only for events seen for the first time,
    // so a re-sent batch adds nothing.
    const newIds = new Set(inserted.filter((r) => r.type === "sent").map((r) => r.id));
    const sent = incoming.filter((e) => e.type === "sent" && newIds.has(e.id));
    if (sent.length) {
      let managerName: string | null = null;
      if (account.managerId) {
        const [m] = await db.select({ name: schema.managers.name }).from(schema.managers).where(eq(schema.managers.id, account.managerId)).limit(1);
        managerName = m?.name ?? null;
      }
      await db
        .insert(schema.sentMail)
        .values(
          sent.map((e) => ({
            id: e.id,
            accountId: account.id,
            sender: account.email,
            managerId: account.managerId,
            managerName,
            recipient: e.recipients && e.recipients.length ? e.recipients.join(", ").slice(0, 1000) : null,
            recipientCount: Math.max(1, e.recipients ? e.recipients.length : 1),
            subject: e.subject ? e.subject.slice(0, 500) : null,
            tier: account.tier,
            late: !!e.late,
            sentAt: new Date(Number.isFinite(e.t) ? e.t : Date.now()),
          })),
        )
        .onConflictDoNothing({ target: schema.sentMail.id });
    }

    const blocks = inserted.filter((r) => r.type === "blocked").length;
    if (blocks) {
      await db
        .update(schema.accounts)
        .set({ blockCount: sql`${schema.accounts.blockCount} + ${blocks}` })
        .where(eq(schema.accounts.id, account.id));
    }
  }

  // A matching ack retires the pending command.
  let pendingCommand = account.pendingCommand;
  let pendingCommandId = account.pendingCommandId;
  const acks = hb.acks ?? [];
  if (pendingCommandId && acks.some((a) => a.id === pendingCommandId)) {
    await db
      .update(schema.accounts)
      .set({ pendingCommand: null, pendingCommandId: null, pendingTier: null, pendingCommandAt: null })
      .where(eq(schema.accounts.id, account.id));
    pendingCommand = null;
    pendingCommandId = null;
  }

  let command: HeartbeatReply["command"] = null;
  if (pendingCommandId && pendingCommand === "start") {
    command = { id: pendingCommandId, type: "start", tier: isTier(account.pendingTier) ? account.pendingTier : undefined };
  } else if (pendingCommandId && pendingCommand === "stop") {
    command = { id: pendingCommandId, type: "stop" };
  }

  const reply: HeartbeatReply = { ok: true, serverTime: Date.now(), command };
  return json(reply);
}
