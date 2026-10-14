import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { statusOf, BUCKET_LABEL } from "@/lib/status";
import { ago, fmtDateTime, fmtInterval, inFuture, nowMs, stopReasonLabel } from "@/lib/format";
import { dashboardTz } from "@/lib/stats";
import { AutoRefresh } from "@/components/AutoRefresh";
import { StatusPill } from "@/components/StatusPill";
import { btn, btnDanger, btnPrimary, Card, input, select, Stat, td, th } from "@/components/ui";
import { cancelCommand, deleteAccount, queueCommand, setDailyLimit, setInterval, setManager } from "../../actions";

export const dynamic = "force-dynamic";

const TYPE_CLASS: Record<string, string> = {
  sent: "text-emerald-700 dark:text-emerald-300",
  blocked: "text-red-700 dark:text-red-300",
  failed: "text-amber-700 dark:text-amber-300",
  bounce: "text-amber-700 dark:text-amber-300",
  started: "text-zinc-600 dark:text-zinc-300",
  stopped: "text-zinc-600 dark:text-zinc-300",
};

export default async function AccountPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  const tz = dashboardTz();

  const [a] = await db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).limit(1);
  if (!a) notFound();

  const [managers, events] = await Promise.all([
    db.select().from(schema.managers).orderBy(asc(schema.managers.name)),
    db.select().from(schema.events).where(eq(schema.events.accountId, id)).orderBy(desc(schema.events.occurredAt)).limit(200),
  ]);
  const now = nowMs();
  const status = statusOf(a, now);

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={30} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link href="/" className="text-xs text-zinc-500 hover:underline">← Accounts</Link>
          <h1 className="text-xl font-semibold">{a.email || "unknown account"}</h1>
          <div className="text-xs text-zinc-500">
            device {a.deviceId} · v{a.version || "?"} · first seen {fmtDateTime(a.createdAt, tz)} · last seen {ago(a.lastSeenAt, now)}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill status={status} title={stopReasonLabel(a.stopReason)} />
          {a.pendingCommand ? (
            <form action={cancelCommand} className="flex items-center gap-2">
              <input type="hidden" name="accountId" value={a.id} />
              <span className="text-xs text-amber-700 dark:text-amber-300">{a.pendingCommand} pending…</span>
              <button className={btn}>Cancel</button>
            </form>
          ) : (
            <form action={queueCommand} className="flex gap-1">
              <input type="hidden" name="accountId" value={a.id} />
              <button name="type" value="start" className={btnPrimary} disabled={a.running && a.stopReason !== "daily_cap"}>Start</button>
              <button name="type" value="stop" className={btnDanger} disabled={!a.running}>Stop</button>
            </form>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
        <Stat label="Sent today" value={a.sentToday} />
        <Stat label="Sent total" value={a.totalSent} />
        <Stat label="Drafts left" value={BUCKET_LABEL[a.remainingBucket] ?? a.remainingBucket} />
        <Stat label="Bounced" value={a.bounceCount} />
        <Stat label="Blocks" value={a.blockCount} />
        <Stat
          label={status === "running" ? "Next send" : "Last send"}
          value={status === "running" ? (a.busy ? "now" : inFuture(a.nextSendAt, now) || "—") : a.lastSendAt ? ago(a.lastSendAt, now) : "never"}
          sub={status === "running" ? "last " + (a.lastSendAt ? ago(a.lastSendAt, now) : "never") : fmtDateTime(a.lastSendAt, tz)}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card title="Manager">
          <form action={setManager} className="flex items-center gap-1">
            <input type="hidden" name="accountId" value={a.id} />
            <select name="managerId" defaultValue={a.managerId ?? ""} className={select}>
              <option value="">— Unassigned —</option>
              {managers.map((m) => (
                <option key={m.id} value={m.id}>{m.name}</option>
              ))}
            </select>
            <button className={btn}>Set</button>
          </form>
        </Card>
        <Card title={"Interval (" + fmtInterval(a.minMinutes, a.maxMinutes) + ")"}>
          <form action={setInterval} className="flex items-center gap-1">
            <input type="hidden" name="accountId" value={a.id} />
            <input name="minMinutes" type="number" step="0.5" min="0.5" max="1440" defaultValue={a.minMinutes} className={input + " w-20"} />
            <span className="text-zinc-400">–</span>
            <input name="maxMinutes" type="number" step="0.5" min="0.5" max="1440" defaultValue={a.maxMinutes} className={input + " w-20"} />
            <span className="text-xs text-zinc-500">min</span>
            <button className={btn}>Set</button>
          </form>
        </Card>
        <Card title={"Daily cap (" + (a.dailyLimit || "off") + ")"}>
          <form action={setDailyLimit} className="flex items-center gap-1">
            <input type="hidden" name="accountId" value={a.id} />
            <input name="dailyLimit" type="number" min="0" max="2000" defaultValue={a.dailyLimit} className={input + " w-24"} />
            <span className="text-xs text-zinc-500">0 = off</span>
            <button className={btn}>Set</button>
          </form>
        </Card>
      </div>

      <Card title="Activity (last 200 events)">
        {events.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead className="border-b border-zinc-200 dark:border-zinc-800">
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>Type</th>
                  <th className={th}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                    <td className={td + " whitespace-nowrap text-xs text-zinc-500"}>{fmtDateTime(e.occurredAt, tz)}</td>
                    <td className={td + " text-xs font-medium " + (TYPE_CLASS[e.type] || "")}>
                      {e.type}
                      {e.reason && <span className="font-normal text-zinc-500"> · {e.type === "stopped" ? stopReasonLabel(e.reason) : e.reason}</span>}
                    </td>
                    <td className={td + " text-xs"}>
                      {e.subject && <span className="font-medium">“{e.subject}”</span>}
                      {e.recipient && <span className="text-zinc-500"> → {e.recipient}</span>}
                      {e.message && <div className="text-zinc-500">{e.message}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Danger zone">
        <form action={deleteAccount} className="flex items-center gap-3">
          <input type="hidden" name="accountId" value={a.id} />
          <p className="text-xs text-zinc-500">Removes this account and its history. If the extension is still running it re-registers itself with default settings on its next heartbeat.</p>
          <button className={btnDanger}>Delete account</button>
        </form>
      </Card>
    </div>
  );
}
