import { NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { heartbeatSchema, type HeartbeatEvent, type HeartbeatReply } from "@/lib/heartbeat";

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

function clampSettings(min: number, max: number, cap: number) {
  let lo = Math.max(0.5, Number(min) || 10);
  let hi = Math.max(0.5, Number(max) || 50);
  if (lo > hi) [lo, hi] = [hi, lo];
  return { minMinutes: lo, maxMinutes: hi, dailyLimit: Math.max(0, Math.floor(Number(cap) || 0)) };
}

function toEventRow(accountId: string, e: HeartbeatEvent) {
  const recipient =
    (e.recipients && e.recipients.length ? e.recipients.join(", ") : e.from) || null;
  const reason = e.reason || e.code || e.source || null;
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

  // Upsert the account by device id. Settings are NOT taken from the
  // extension: the dashboard owns them and hands them back below.
  const reported = {
    email: hb.email ? hb.email.toLowerCase() : null,
    version: hb.version ?? null,
    running: hb.running ?? false,
    busy: hb.busy ?? false,
    stopReason: hb.stopReason || null,
    gmailTabOpen: hb.gmailTabOpen ?? false,
    nextSendAt: hb.nextSendAt ? new Date(hb.nextSendAt) : null,
    lastSendAt: hb.lastSendAt ? new Date(hb.lastSendAt) : null,
    remainingBucket: hb.remainingBucket ?? "unknown",
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

  // Events: inserted once each, by the id the extension generated.
  const incoming = hb.events ?? [];
  if (incoming.length) {
    const rows = incoming.map((e) => toEventRow(account.id, e));
    const inserted = await db
      .insert(schema.events)
      .values(rows)
      .onConflictDoNothing({ target: schema.events.id })
      .returning({ type: schema.events.type });
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
      .set({ pendingCommand: null, pendingCommandId: null, pendingCommandAt: null })
      .where(eq(schema.accounts.id, account.id));
    pendingCommand = null;
    pendingCommandId = null;
  }

  const desired = clampSettings(account.minMinutes, account.maxMinutes, account.dailyLimit);
  const reply: HeartbeatReply = {
    ok: true,
    serverTime: Date.now(),
    desired,
    command:
      pendingCommand && pendingCommandId && (pendingCommand === "start" || pendingCommand === "stop")
        ? { id: pendingCommandId, type: pendingCommand }
        : null,
  };
  return json(reply);
}
