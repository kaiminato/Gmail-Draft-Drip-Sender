import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { statusOf, draftsLevel, BUCKET_LABEL } from "@/lib/status";
import { ago, fmtDateTime, inFuture, nowMs, overdue, stopReasonLabel } from "@/lib/format";
import { dashboardTz } from "@/lib/stats";
import { TIER_META, TIER_ORDER } from "@/lib/tiers";
import { AutoRefresh } from "@/components/AutoRefresh";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { StatusPill } from "@/components/StatusPill";
import { TierBadge } from "@/components/TierBadge";
import { btn, btnDanger, btnTier, Card, select, Stat, td, th } from "@/components/ui";
import { cancelCommand, deleteAccount, queueCommand, setManager } from "../../actions";

export const dynamic = "force-dynamic";

const TYPE_CLASS: Record<string, string> = {
  sent: "text-accent",
  blocked: "text-danger",
  failed: "text-warn",
  bounce: "text-warn",
  started: "text-muted",
  stopped: "text-muted",
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
  const drafts = draftsLevel(a.remainingCount, a.remainingBucket);

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={30} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/" className="text-xs text-muted hover:text-fg">← Accounts</Link>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">{a.email || "unknown account"}</h1>
          <div className="text-xs text-muted">
            device {a.deviceId} · v{a.version || "?"} · first seen {fmtDateTime(a.createdAt, tz)} · last seen {ago(a.lastSeenAt, now)}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill status={status} title={stopReasonLabel(a.stopReason)} />
          {a.pendingCommand && (
            <form action={cancelCommand} className="flex items-center gap-2">
              <input type="hidden" name="accountId" value={a.id} />
              <span className="text-xs text-warn">{a.pendingCommand}{a.pendingTier ? " " + a.pendingTier : ""} pending…</span>
              <button className={btn}>Cancel</button>
            </form>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Mode" value={<TierBadge tier={a.tier} />} sub={a.tierSetAt ? "set " + ago(a.tierSetAt, now) : undefined} />
        <Stat label="Today" value={a.dayTarget ? a.sentToday + " / " + a.dayTarget : a.sentToday} sub={a.plannedLeft != null && a.running ? a.plannedLeft + " to go" : "sent"} />
        <Stat label="Sent total" value={a.totalSent} />
        <Stat
          label="Drafts left"
          value={typeof a.remainingCount === "number" ? a.remainingCount : (BUCKET_LABEL[a.remainingBucket] ?? "—")}
          tone={drafts === "zero" ? "danger" : drafts === "low" ? "warn" : undefined}
          sub={drafts === "unknown" ? "counted after the first send" : "as of the last send"}
        />
        <Stat label="Bounced / blocks" value={<span>{a.bounceCount} <span className="text-muted">/</span> <span className={a.blockCount ? "text-danger" : ""}>{a.blockCount}</span></span>} />
        <Stat
          label={status === "running" ? "Next send" : "Last send"}
          value={status === "running" ? (a.busy ? "now" : a.stopReason === "daily_cap" ? "tomorrow" : overdue(a.nextSendAt, now) ? "overdue" : inFuture(a.nextSendAt, now) || "—") : a.lastSendAt ? ago(a.lastSendAt, now) : "never"}
          tone={status === "running" && !a.busy && a.stopReason !== "daily_cap" && overdue(a.nextSendAt, now) ? "warn" : undefined}
          sub={status === "running" ? (overdue(a.nextSendAt, now) && !a.busy && a.stopReason !== "daily_cap" ? "planned " + ago(a.nextSendAt, now) + ", nothing sent since" : a.restStart ? "rest " + a.restStart + "–" + a.restEnd : "last " + (a.lastSendAt ? ago(a.lastSendAt, now) : "never")) : fmtDateTime(a.lastSendAt, tz)}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Control">
          {a.pendingCommand ? (
            <p className="text-sm text-muted">A command is pending; it applies on the next heartbeat.</p>
          ) : (
            <form action={queueCommand} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="accountId" value={a.id} />
              {TIER_ORDER.map((t) => (
                <button key={t} name="action" value={"start:" + t} className={btnTier + " " + TIER_META[t].bar} disabled={a.running && a.tier === t} title={TIER_META[t].range}>
                  {a.running ? "Switch to " : "Start "}{TIER_META[t].label.toLowerCase()}
                </button>
              ))}
              <button name="action" value="stop" className={btnDanger} disabled={!a.running}>Stop</button>
            </form>
          )}
          <p className="mt-2 text-xs text-muted">Starting from here is staggered by up to 20 minutes. The popup on the machine can also start, stop or switch mode; this page shows whichever happened last.</p>
        </Card>
        <Card title="Manager">
          <form action={setManager} key={a.managerId ?? "none"}>
            <input type="hidden" name="accountId" value={a.id} />
            <AutoSubmitSelect
              name="managerId"
              value={a.managerId ?? ""}
              options={managers.map((m) => ({ value: m.id, label: m.name }))}
              placeholder="— Unassigned —"
              className={select + " w-full"}
              title="Saves on change"
            />
          </form>
        </Card>
      </div>

      <Card title="Activity (last 200 events)">
        {events.length === 0 ? (
          <p className="text-sm text-muted">Nothing yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead className="border-b border-line">
                <tr>
                  <th className={th}>When</th>
                  <th className={th}>Type</th>
                  <th className={th}>Detail</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-b border-line/60 last:border-0">
                    <td className={td + " num whitespace-nowrap text-xs text-muted"}>{fmtDateTime(e.occurredAt, tz)}</td>
                    <td className={td + " text-xs font-medium " + (TYPE_CLASS[e.type] || "")}>
                      {e.type}
                      {e.reason && <span className="font-normal text-muted"> · {e.type === "stopped" ? stopReasonLabel(e.reason) : e.reason}</span>}
                    </td>
                    <td className={td + " text-xs"}>
                      {e.subject && <span className="font-medium">“{e.subject}”</span>}
                      {e.recipient && <span className="text-muted"> → {e.recipient}</span>}
                      {e.message && <div className="text-muted">{e.message}</div>}
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
          <p className="text-xs text-muted">Removes this account and its history. If the extension is still running it re-registers itself on its next heartbeat.</p>
          <button className={btnDanger}>Delete account</button>
        </form>
      </Card>
    </div>
  );
}
