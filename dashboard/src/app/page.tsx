import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { statusOf, draftsLevel, BUCKET_LABEL, LOW_DRAFTS } from "@/lib/status";
import { ago, cmpVersion, fmtDateTime, inFuture, nowMs, stopReasonLabel } from "@/lib/format";
import { dashboardTz } from "@/lib/stats";
import { TIER_META, TIER_ORDER } from "@/lib/tiers";
import { AutoRefresh } from "@/components/AutoRefresh";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { BulkBar, SelectAll } from "@/components/BulkBar";
import { ManagerFilter } from "@/components/ManagerFilter";
import { StatusPill } from "@/components/StatusPill";
import { TierBadge } from "@/components/TierBadge";
import { btn, btnDanger, btnPrimary, btnTier, PageHeader, select, Stat, tableWrap, td, th } from "@/components/ui";
import { bulkAct, cancelCommand, queueCommand, setManager } from "./actions";

export const dynamic = "force-dynamic";

const cell = td + " whitespace-nowrap";

export default async function AccountsPage({
  searchParams,
}: {
  searchParams: Promise<{ manager?: string }>;
}) {
  await requireAdmin();
  const { manager: filter = "" } = await searchParams;
  const tz = dashboardTz();

  const managers = await db.select().from(schema.managers).orderBy(asc(schema.managers.name));
  const where = filter && filter !== "none" ? eq(schema.accounts.managerId, filter) : undefined;
  let accounts = await db
    .select()
    .from(schema.accounts)
    .where(where)
    .orderBy(asc(schema.accounts.email), asc(schema.accounts.createdAt));
  if (filter === "none") accounts = accounts.filter((a) => !a.managerId);

  const managerOptions = managers.map((m) => ({ value: m.id, label: m.name }));
  const managerName = new Map(managers.map((m) => [m.id, m.name]));
  const now = nowMs();
  const rows = accounts.map((a) => ({ a, status: statusOf(a, now), drafts: draftsLevel(a.remainingCount, a.remainingBucket) }));

  const tally = { running: 0, stopped: 0, empty: 0, blocked: 0, offline: 0 };
  for (const r of rows) tally[r.status]++;
  const sentToday = rows.reduce((n, r) => n + r.a.sentToday, 0);
  const targetToday = rows.reduce((n, r) => n + (r.a.running && r.a.dayTarget ? r.a.dayTarget : 0), 0);
  const lowDrafts = rows.filter((r) => r.drafts === "low" || r.drafts === "zero").length;
  const latestVersion = accounts.reduce<string | null>(
    (best, a) => (a.version && cmpVersion(a.version, best) > 0 ? a.version : best),
    null,
  );
  const behind = rows.filter((r) => r.a.version && cmpVersion(r.a.version, latestVersion) < 0).length;

  const scope = filter === "none" ? "" : filter;
  const scopeLabel = filter === "none"
    ? "all " + rows.length + " unassigned"
    : filter
      ? "all " + rows.length + " under " + (managerName.get(filter) ?? "this manager")
      : "all " + rows.length + " accounts";

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={30} />

      <PageHeader title="Accounts" description="Every extension install, as reported on its last heartbeat.">
        <ManagerFilter value={filter} managers={managers} className={select} />
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <Stat label="Accounts" value={rows.length} />
        <Stat label="Running" value={tally.running} tone="accent" />
        <Stat label="Stopped" value={tally.stopped} sub={tally.empty + " out of drafts"} />
        <Stat label="Blocked" value={tally.blocked} tone={tally.blocked ? "danger" : undefined} />
        <Stat label="Offline" value={tally.offline} tone={tally.offline ? "warn" : undefined} />
        <Stat label="Sent today" value={sentToday} sub={targetToday ? "of " + targetToday + " planned" : "as reported"} />
        <Stat label="Low on drafts" value={lowDrafts} tone={lowDrafts ? "warn" : undefined} sub={"fewer than " + LOW_DRAFTS + " left"} />
        <Stat label="Extension" value={latestVersion ? "v" + latestVersion : "—"} sub={behind ? behind + " behind" : "all up to date"} tone={behind ? "warn" : undefined} />
      </div>

      {/* The bulk form itself holds only the scope; buttons and row boxes
          point at it with form="bulk", so the per-row forms stay valid. */}
      <form id="bulk" action={bulkAct}>
        <input type="hidden" name="managerId" value={scope} />
      </form>
      <BulkBar scopeLabel={scopeLabel} />

      <div className={tableWrap}>
        <table className="w-full border-collapse text-sm">
          <thead className="border-b border-line">
            <tr>
              <th className={th + " w-8"}><SelectAll /></th>
              <th className={th}>Account</th>
              <th className={th}>Manager</th>
              <th className={th}>Mode</th>
              <th className={th}>Status</th>
              <th className={th + " text-right"}>Drafts left</th>
              <th className={th}>Last send</th>
              <th className={th + " text-right"}>Total</th>
              <th className={th}>Version</th>
              <th className={th}>Control</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-10 text-center text-sm text-muted">
                  No accounts yet. Accounts appear here on their own once an extension with the right API key sends its first heartbeat.
                </td>
              </tr>
            )}
            {rows.map(({ a, status, drafts }) => (
              <tr
                key={a.id}
                className={"border-b border-line/60 last:border-0 " + (drafts === "zero" ? "row-zero" : drafts === "low" ? "row-low" : "")}
              >
                <td className={cell}>
                  <input type="checkbox" name="ids" value={a.id} form="bulk" aria-label={"Select " + (a.email || a.deviceId)} />
                </td>
                <td className={cell}>
                  <Link href={"/accounts/" + a.id} className="font-medium hover:text-accent">
                    {a.email || <span className="text-muted">unknown · {a.deviceId.slice(0, 8)}</span>}
                  </Link>
                  <div className="text-xs text-muted">
                    seen {ago(a.lastSeenAt, now)}
                    {!a.gmailTabOpen && status !== "offline" && " · no Gmail tab"}
                  </div>
                </td>
                <td className={cell}>
                  <form action={setManager} key={a.managerId ?? "none"}>
                    <input type="hidden" name="accountId" value={a.id} />
                    <AutoSubmitSelect
                      name="managerId"
                      value={a.managerId ?? ""}
                      options={managerOptions}
                      placeholder="—"
                      className={select + " h-6 py-0 text-xs"}
                      title={managers.length ? "Saves on change" : "Create managers on the Managers page first"}
                    />
                  </form>
                </td>
                <td className={cell}>
                  <div className="flex items-center gap-2">
                    <TierBadge tier={a.tier} />
                    {a.running && a.dayTarget ? (
                      <span className="num text-xs">{a.sentToday} / {a.dayTarget}</span>
                    ) : (
                      <span className="num text-xs text-muted">{a.sentToday} today</span>
                    )}
                  </div>
                  {a.running && a.plannedLeft != null && a.plannedLeft > 0 && (
                    <div className="text-xs text-muted">{a.plannedLeft} to go</div>
                  )}
                </td>
                <td className={cell}>
                  <StatusPill status={status} title={stopReasonLabel(a.stopReason)} />
                  <div className="text-xs text-muted">
                    {status === "running" && a.busy && "sending now"}
                    {status === "running" && !a.busy && a.stopReason === "daily_cap" && "done for today"}
                    {status === "running" && !a.busy && a.stopReason !== "daily_cap" && a.nextSendAt && "next " + inFuture(a.nextSendAt, now)}
                    {status === "running" && a.restStart && " · rest " + a.restStart + "–" + a.restEnd}
                    {status !== "running" && status !== "offline" && stopReasonLabel(a.stopReason)}
                    {status === "offline" && "last seen " + ago(a.lastSeenAt, now)}
                  </div>
                </td>
                <td
                  className={cell + " num text-right " + (drafts === "zero" ? "font-semibold text-danger" : drafts === "low" ? "font-semibold text-warn" : "")}
                  title={drafts === "unknown" ? "Not counted yet; updates after the first send" : "As of the last send"}
                >
                  {typeof a.remainingCount === "number" ? a.remainingCount : (BUCKET_LABEL[a.remainingBucket] ?? "—")}
                </td>
                <td className={cell}>
                  {a.lastSendAt ? (
                    <>
                      {ago(a.lastSendAt, now)}
                      <div className="text-xs text-muted">{fmtDateTime(a.lastSendAt, tz)}</div>
                    </>
                  ) : (
                    <span className="text-muted">never</span>
                  )}
                </td>
                <td className={cell + " num text-right"}>
                  {a.totalSent}
                  {(a.bounceCount > 0 || a.blockCount > 0) && (
                    <div className="text-xs text-muted">
                      {a.bounceCount > 0 && a.bounceCount + " bounced"}
                      {a.bounceCount > 0 && a.blockCount > 0 && " · "}
                      {a.blockCount > 0 && <span className="text-danger">{a.blockCount} blocks</span>}
                    </div>
                  )}
                </td>
                <td className={cell + " num text-xs"}>
                  {!a.version ? (
                    <span className="text-muted">—</span>
                  ) : cmpVersion(a.version, latestVersion) < 0 ? (
                    <span className="rounded-md bg-warn/15 px-1.5 py-0.5 font-medium text-warn" title={"Newest seen is v" + latestVersion}>v{a.version}</span>
                  ) : (
                    "v" + a.version
                  )}
                </td>
                <td className={cell}>
                  {a.pendingCommand ? (
                    <form action={cancelCommand} className="flex items-center gap-2">
                      <input type="hidden" name="accountId" value={a.id} />
                      <span className="text-xs text-warn" title="Takes effect on the extension's next heartbeat">
                        {a.pendingCommand}{a.pendingTier ? " " + a.pendingTier : ""} pending…
                      </span>
                      <button className={btn}>Cancel</button>
                    </form>
                  ) : (
                    <form action={queueCommand} className="flex items-center gap-1">
                      <input type="hidden" name="accountId" value={a.id} />
                      <details className="relative">
                        <summary className={(a.running ? btn : btnPrimary) + " cursor-pointer list-none"}>
                          {a.running ? "Switch ▾" : "Start ▾"}
                        </summary>
                        <div className="absolute left-0 z-20 mt-1 flex w-36 flex-col gap-1 rounded-lg border border-line bg-panel p-1 shadow-xl shadow-black/40">
                          {TIER_ORDER.map((t) => (
                            <button key={t} name="action" value={"start:" + t} className={btnTier + " justify-between " + TIER_META[t].bar} disabled={a.running && a.tier === t}>
                              <span>{TIER_META[t].label}</span>
                              <span className="num text-[10px] text-muted">{TIER_META[t].range.replace(" / day", "")}</span>
                            </button>
                          ))}
                        </div>
                      </details>
                      <button name="action" value="stop" className={btnDanger} disabled={!a.running}>Stop</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">
        Commands reach an extension on its next heartbeat, about half a minute. Starts from here are staggered over 20 minutes so accounts do not move together. Times shown in {tz}.
      </p>
    </div>
  );
}
