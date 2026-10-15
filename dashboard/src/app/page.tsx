import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { statusOf, BUCKET_LABEL } from "@/lib/status";
import { ago, cmpVersion, fmtDateTime, inFuture, nowMs, stopReasonLabel } from "@/lib/format";
import { dashboardTz } from "@/lib/stats";
import { AutoRefresh } from "@/components/AutoRefresh";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { ManagerFilter } from "@/components/ManagerFilter";
import { StatusPill } from "@/components/StatusPill";
import { btn, btnDanger, btnPrimary, Card, input, select, Stat, td, th } from "@/components/ui";
import { cancelCommand, queueCommand, queueCommandBulk, setDailyLimit, setInterval, setManager, setSettingsBulk } from "./actions";

export const dynamic = "force-dynamic";

const cell = td + " whitespace-nowrap";
const tiny = input + " w-14 px-1.5 py-0.5 text-xs";

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
  const now = nowMs();
  const rows = accounts.map((a) => ({ a, status: statusOf(a, now) }));

  const tally = { running: 0, stopped: 0, empty: 0, blocked: 0, offline: 0 };
  for (const r of rows) tally[r.status]++;
  const sentToday = rows.reduce((n, r) => n + r.a.sentToday, 0);
  const latestVersion = accounts.reduce<string | null>(
    (best, a) => (a.version && cmpVersion(a.version, best) > 0 ? a.version : best),
    null,
  );
  const behind = rows.filter((r) => r.a.version && cmpVersion(r.a.version, latestVersion) < 0).length;
  const scope = filter === "none" ? "" : filter;
  const scopeLabel = filter ? "these" : "all";

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={30} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Stat label="Accounts" value={rows.length} />
        <Stat label="Running" value={tally.running} />
        <Stat label="Stopped" value={tally.stopped} sub={tally.empty + " empty"} />
        <Stat label="Blocked" value={tally.blocked} />
        <Stat label="Offline" value={tally.offline} />
        <Stat label="Sent today" value={sentToday} sub="as reported" />
        <Stat label="Extension" value={latestVersion ? "v" + latestVersion : "—"} sub={behind ? behind + " behind" : "all up to date"} />
      </div>

      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <ManagerFilter value={filter} managers={managers} className={select} />

          <div className="flex flex-wrap items-center gap-3">
            <form action={queueCommandBulk} className="flex gap-1">
              <input type="hidden" name="managerId" value={scope} />
              <button name="type" value="start" className={btnPrimary}>Start {scopeLabel}</button>
              <button name="type" value="stop" className={btnDanger}>Stop {scopeLabel}</button>
            </form>
            <form action={setSettingsBulk} className="flex items-center gap-1 text-xs text-zinc-500">
              <input type="hidden" name="managerId" value={scope} />
              <span>min</span>
              <input name="minMinutes" type="number" step="0.5" min="0.5" defaultValue={10} className={tiny} />
              <span>max</span>
              <input name="maxMinutes" type="number" step="0.5" min="0.5" defaultValue={50} className={tiny} />
              <span>cap</span>
              <input name="dailyLimit" type="number" min="0" defaultValue={0} className={tiny} />
              <button className={btn}>Apply to {scopeLabel}</button>
            </form>
          </div>
        </div>
      </Card>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full border-collapse text-sm">
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className={th}>Account</th>
              <th className={th}>Version</th>
              <th className={th}>Manager</th>
              <th className={th}>Status</th>
              <th className={th}>Last send</th>
              <th className={th + " text-center"}>Drafts</th>
              <th className={th + " text-right"}>Today / total</th>
              <th className={th}>Interval (min)</th>
              <th className={th}>Daily cap</th>
              <th className={th}>Control</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={10} className="px-2 py-8 text-center text-sm text-zinc-500">
                  No accounts yet. Accounts appear here on their own once an extension with the right API key sends its first heartbeat.
                </td>
              </tr>
            )}
            {rows.map(({ a, status }) => (
              <tr key={a.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                <td className={cell}>
                  <Link href={"/accounts/" + a.id} className="font-medium hover:underline">
                    {a.email || <span className="text-zinc-400">unknown · {a.deviceId.slice(0, 8)}</span>}
                  </Link>
                  <div className="text-xs text-zinc-500">
                    seen {ago(a.lastSeenAt, now)}
                    {!a.gmailTabOpen && status !== "offline" && " · no Gmail tab"}
                  </div>
                </td>
                <td className={cell + " tabular-nums"}>
                  {!a.version ? (
                    <span className="text-zinc-400">—</span>
                  ) : cmpVersion(a.version, latestVersion) < 0 ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" title={"Newest seen is v" + latestVersion}>
                      v{a.version}
                    </span>
                  ) : (
                    "v" + a.version
                  )}
                </td>
                <td className={cell}>
                  <form action={setManager} key={a.managerId ?? "none"}>
                    <input type="hidden" name="accountId" value={a.id} />
                    <AutoSubmitSelect
                      name="managerId"
                      value={a.managerId ?? ""}
                      options={managerOptions}
                      placeholder="—"
                      className={select + " py-0.5 text-xs"}
                      title={managers.length ? "Saves on change" : "Create managers on the Managers page first"}
                    />
                  </form>
                </td>
                <td className={cell}>
                  <StatusPill status={status} title={stopReasonLabel(a.stopReason)} />
                  <div className="text-xs text-zinc-500">
                    {status === "running" && a.busy && "sending now"}
                    {status === "running" && !a.busy && a.stopReason === "daily_cap" && "cap reached, resumes tomorrow"}
                    {status === "running" && !a.busy && a.stopReason !== "daily_cap" && a.nextSendAt && "next " + inFuture(a.nextSendAt, now)}
                    {status !== "running" && status !== "offline" && stopReasonLabel(a.stopReason)}
                    {status === "offline" && "last seen " + ago(a.lastSeenAt, now)}
                  </div>
                </td>
                <td className={cell}>
                  {a.lastSendAt ? (
                    <>
                      {ago(a.lastSendAt, now)}
                      <div className="text-xs text-zinc-500">{fmtDateTime(a.lastSendAt, tz)}</div>
                    </>
                  ) : (
                    <span className="text-zinc-400">never</span>
                  )}
                </td>
                <td className={cell + " text-center tabular-nums"} title={a.remainingBucket === "unknown" ? "Not counted yet; updates after the first send" : "As of the last send"}>
                  {BUCKET_LABEL[a.remainingBucket] ?? a.remainingBucket}
                </td>
                <td className={cell + " text-right tabular-nums"}>
                  {a.sentToday} / {a.totalSent}
                  {(a.bounceCount > 0 || a.blockCount > 0) && (
                    <div className="text-xs text-zinc-500">
                      {a.bounceCount > 0 && a.bounceCount + " bounced"}
                      {a.bounceCount > 0 && a.blockCount > 0 && " · "}
                      {a.blockCount > 0 && a.blockCount + " blocks"}
                    </div>
                  )}
                </td>
                <td className={cell}>
                  <form action={setInterval} className="flex items-center gap-1" key={a.minMinutes + "-" + a.maxMinutes}>
                    <input type="hidden" name="accountId" value={a.id} />
                    <input name="minMinutes" type="number" step="0.5" min="0.5" max="1440" defaultValue={a.minMinutes} className={tiny} />
                    <span className="text-zinc-400">–</span>
                    <input name="maxMinutes" type="number" step="0.5" min="0.5" max="1440" defaultValue={a.maxMinutes} className={tiny} />
                    <button className={btn}>Set</button>
                  </form>
                </td>
                <td className={cell}>
                  <form action={setDailyLimit} className="flex items-center gap-1" key={a.dailyLimit}>
                    <input type="hidden" name="accountId" value={a.id} />
                    <input name="dailyLimit" type="number" min="0" max="2000" defaultValue={a.dailyLimit} className={tiny} title="0 = no cap" />
                    <button className={btn}>Set</button>
                  </form>
                </td>
                <td className={cell}>
                  {a.pendingCommand ? (
                    <form action={cancelCommand} className="flex items-center gap-2">
                      <input type="hidden" name="accountId" value={a.id} />
                      <span className="text-xs text-amber-700 dark:text-amber-300" title="Takes effect on the extension's next heartbeat">
                        {a.pendingCommand} pending…
                      </span>
                      <button className={btn}>Cancel</button>
                    </form>
                  ) : (
                    <form action={queueCommand} className="flex gap-1">
                      <input type="hidden" name="accountId" value={a.id} />
                      <button name="type" value="start" className={btnPrimary} disabled={a.running && a.stopReason !== "daily_cap"}>Start</button>
                      <button name="type" value="stop" className={btnDanger} disabled={!a.running}>Stop</button>
                    </form>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-zinc-500">
        Commands and settings reach an extension on its next heartbeat. Times shown in {tz}.
      </p>
    </div>
  );
}
