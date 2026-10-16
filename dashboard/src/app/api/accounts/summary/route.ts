import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db, schema } from "@/db";
import { currentAdmin } from "@/lib/admin";
import type { AccountSnap } from "@/lib/alerts";
import { draftsLevel, statusOf } from "@/lib/status";

export const dynamic = "force-dynamic";

// The compact picture the alert watcher polls: one line per account with
// its status and drafts level. Admin session required, like every page.
export async function GET() {
  if (!(await currentAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rows = await db
    .select({
      id: schema.accounts.id,
      email: schema.accounts.email,
      deviceId: schema.accounts.deviceId,
      running: schema.accounts.running,
      stopReason: schema.accounts.stopReason,
      lastSeenAt: schema.accounts.lastSeenAt,
      remainingCount: schema.accounts.remainingCount,
      remainingBucket: schema.accounts.remainingBucket,
    })
    .from(schema.accounts)
    .orderBy(asc(schema.accounts.email));
  const now = Date.now();
  const accounts: AccountSnap[] = rows.map((a) => ({
    id: a.id,
    name: a.email || "unknown · " + a.deviceId.slice(0, 8),
    status: statusOf(a, now),
    drafts: draftsLevel(a.remainingCount, a.remainingBucket),
    count: a.remainingCount,
  }));
  return NextResponse.json({ now, accounts }, { headers: { "Cache-Control": "no-store" } });
}
