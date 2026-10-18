import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import type { Account } from "@/db/schema";
import { requireAdmin } from "@/lib/admin";
import { statusOf, draftsLevel, BUCKET_LABEL, LOW_DRAFTS, type Status } from "@/lib/status";
import { accountMatches, filterWords } from "@/lib/filter";
import { ago, cmpVersion, fmtDateTime, inFuture, nowMs, overdue, stopReasonLabel } from "@/lib/format";
import { dashboardTz } from "@/lib/stats";
import { TIER_META, TIER_ORDER, isTier } from "@/lib/tiers";
import { AutoRefresh } from "@/components/AutoRefresh";
import { HighlightRow } from "@/components/HighlightRow";
import { AutoSubmitSelect } from "@/components/AutoSubmitSelect";
import { BulkBar, SelectAll } from "@/components/BulkBar";
import { ManagerFilter } from "@/components/ManagerFilter";
import { SearchFilter } from "@/components/SearchFilter";
import { StatusPill } from "@/components/StatusPill";
import { TierBadge } from "@/components/TierBadge";
import { btn, btnDanger, btnPrimary, btnTier, PageHeader, select, Stat, tableWrap, td, th } from "@/components/ui";
import { bulkAct, cancelCommand, queueCommand, setManager } from "./actions";

export const dynamic = "force-dynamic";

const cell = td + " whitespace-nowrap";

/* ---------- sorting ---------- */

// The list sorts on the server from the URL (?sort=drafts&dir=desc), so it
// survives the auto-refresh and combines with the manager filter.
const SORT_KEYS = ["email", "manager", "mode", "status", "drafts", "total"] as const;
type SortKey = (typeof SORT_KEYS)[number];
type Dir = "asc" | "desc";
const isSortKey = (x: unknown): x is SortKey => typeof x === "string" && (SORT_KEYS as readonly string[]).includes(x);
// Counts are more useful biggest first; text, A to Z.
const FIRST_DIR: Record<SortKey, Dir> = { email: "asc", manager: "asc", mode: "asc", status: "asc", drafts: "asc", total: "desc" };
const STATUS_RANK: Record<Status, number> = { running: 0, blocked: 1, empty: 2, stopped: 3, offline: 4 };
// A range stands in for a number at a point inside it; "unknown" has no value.
const BUCKET_RANK: Record<string, number> = { none: 0, "1-10": 5, "10+": 11 };

type Row = { a: Account; status: Status; drafts: ReturnType<typeof draftsLevel>; manager: string | null };

// null means "no value"; those rows go last whichever way the sort runs.
function sortValue(r: Row, key: SortKey): string | number | null {
  switch (key) {
    case "email": return (r.a.email || "~" + r.a.deviceId).toLowerCase();
    case "manager": return r.manager ? r.manager.toLowerCase() : null;
    case "mode": return isTier(r.a.tier) ? TIER_ORDER.indexOf(r.a.tier) : null;
    case "status": return STATUS_RANK[r.status];
    case "drafts": return typeof r.a.remainingCount === "number" ? r.a.remainingCount : (BUCKET_RANK[r.a.remainingBucket] ?? null);
    case "total": return r.a.totalSent;
  }
}

function compareRows(key: SortKey, dir: Dir) {
  const sign = dir === "asc" ? 1 : -1;
  return (x: Row, y: Row) => {
    const a = sortValue(x, key);
    const b = sortValue(y, key);
    if (a === null && b === null) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    const d = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
    if (d) return d * sign;
    return sortValue(x, "email")!.toString().localeCompare(sortValue(y, "email")!.toString());
  };
}

// A column header that links to the list sorted by that column; a second
// click on the active one flips the direction.
function SortTh({ col, label, sort, dir, base, className = "" }: { col: SortKey; label: string; sort: SortKey; dir: Dir; base: string; className?: string }) {
  const active = sort === col;
  const next: Dir = active ? (dir === "asc" ? "desc" : "asc") : FIRST_DIR[col];
  return (
    <th className={th + " " + className}>
      <Link
        href={base + "sort=" + col + "&dir=" + next}
        className={"inline-flex items-center gap-1 transition-colors hover:text-fg " + (active ? "text-fg" : "")}
        title={"Sort by " + label.toLowerCase() + (active ? ", " + (next === "asc" ? "ascending" : "descending") : "")}
      >
        {label}
        <span aria-hidden="true" className={"text-[9px] " + (active ? "text-accent" : "text-muted/50")}>
          {active ? (dir === "asc" ? "▲" : "▼") : "⇅"}
        </span>
      </Link>
    </th>
  );
}

export default async function AccountsPage({
  searchParams,
}: {
  // `highlight` (account id) or `device` (the extension's device id) scrolls
  // to that row and marks it: dashboard alerts link with the first, the
  // extension's own notifications with the second.
  // `q` is the text filter: words that must all appear in the email, manager,
  // device id or version (src/lib/filter.ts).
  searchParams: Promise<{ manager?: string; sort?: string; dir?: string; q?: string; highlight?: string; device?: string }>;
}) {
  await requireAdmin();
  const { manager: filter = "", sort: sortParam, dir: dirParam, q: qParam, highlight, device } = await searchParams;
  const q = (qParam || "").trim();
  const words = filterWords(q);
  const sort: SortKey = isSortKey(sortParam) ? sortParam : "email";
  const dir: Dir = dirParam === "asc" || dirParam === "desc" ? dirParam : FIRST_DIR[sort];
  // Links keep both filters; the filters keep the sort.
  const filterQuery = [filter ? "manager=" + encodeURIComponent(filter) : "", q ? "q=" + encodeURIComponent(q) : ""].filter(Boolean).join("&");
  const base = "/?" + (filterQuery ? filterQuery + "&" : "");
  const sortQuery = sortParam ? "sort=" + sort + "&dir=" + dir : "";
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
  const rows: Row[] = accounts
    .map((a) => ({
      a,
      status: statusOf(a, now),
      drafts: draftsLevel(a.remainingCount, a.remainingBucket),
      manager: a.managerId ? managerName.get(a.managerId) ?? null : null,
    }))
    .filter((r) => accountMatches(r.a, r.manager, words));
  rows.sort(compareRows(sort, dir));
  const highlightId =
    (highlight && rows.some((r) => r.a.id === highlight) ? highlight : null) ??
    (device ? rows.find((r) => r.a.deviceId === device)?.a.id ?? null : null);

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
  const scopeLabel =
    (filter === "none"
      ? "all " + rows.length + " unassigned"
      : filter
        ? "all " + rows.length + " under " + (managerName.get(filter) ?? "this manager")
        : "all " + rows.length + " accounts") + (q ? " matching “" + q + "”" : "");

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={30} />
      {highlightId && <HighlightRow id={highlightId} />}

      <PageHeader title="Accounts" description="Every extension install, as reported on its last heartbeat.">
        <div className="flex flex-wrap items-center gap-2">
          <SearchFilter
            value={q}
            keep={[filter ? "manager=" + encodeURIComponent(filter) : "", sortQuery].filter(Boolean).join("&")}
            className="w-64 max-w-full"
          />
          <ManagerFilter value={filter} managers={managers} className={select} keep={[q ? "q=" + encodeURIComponent(q) : "", sortQuery].filter(Boolean).join("&")} />
        </div>
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
        <input type="hidden" name="q" value={q} />
      </form>
      <BulkBar scopeLabel={scopeLabel} />

      <div className={tableWrap}>
        <table className="w-full border-collapse text-sm">
          <thead className="border-b border-line">
            <tr>
              <th className={th + " w-8"}><SelectAll /></th>
              <SortTh col="email" label="Account" sort={sort} dir={dir} base={base} />
              <SortTh col="manager" label="Manager" sort={sort} dir={dir} base={base} />
              <SortTh col="mode" label="Mode" sort={sort} dir={dir} base={base} />
              <SortTh col="status" label="Status" sort={sort} dir={dir} base={base} />
              <SortTh col="drafts" label="Drafts left" sort={sort} dir={dir} base={base} className="text-right" />
              <th className={th}>Last send</th>
              <SortTh col="total" label="Total" sort={sort} dir={dir} base={base} className="text-right" />
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
                id={"acct-" + a.id}
                className={
                  "border-b border-line/60 last:border-0 " +
                  (drafts === "zero" ? "row-zero" : drafts === "low" ? "row-low" : "") +
                  (a.id === highlightId ? " row-highlight" : "")
                }
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
                  {a.running && a.dayTarget != null && a.dayTarget > 0 && a.plannedLeft != null && a.sentToday + a.plannedLeft < a.dayTarget && (
                    <div className="text-xs text-muted" title="A run that starts partway through the day plans a share of the day's target (retried sends can trim it too); the full target applies from tomorrow.">
                      {a.sentToday + a.plannedLeft} planned today, started late
                    </div>
                  )}
                  {a.running && !a.dayTarget && status === "running" && (
                    <div className="text-xs text-warn" title="Running, but the extension has not reported a plan for today">no plan yet</div>
                  )}
                </td>
                <td className={cell}>
                  <StatusPill status={status} title={stopReasonLabel(a.stopReason)} />
                  <div className="text-xs text-muted">
                    {status === "running" && a.busy && "sending now"}
                    {status === "running" && !a.busy && a.stopReason === "daily_cap" && "done for today"}
                    {status === "running" && !a.busy && a.stopReason !== "daily_cap" && a.nextSendAt && !overdue(a.nextSendAt, now) && "next " + inFuture(a.nextSendAt, now)}
                    {status === "running" && !a.busy && a.stopReason !== "daily_cap" && a.nextSendAt && overdue(a.nextSendAt, now) && (
                      <span className="text-warn" title="The planned time passed and nothing was sent; the extension re-arms itself on its next heartbeat">
                        {"send overdue by " + ago(a.nextSendAt, now).replace(" ago", "")}
                      </span>
                    )}
                    {status === "running" && a.restStart && " · rest " + a.restStart + "–" + a.restEnd}
                    {status === "empty" && a.running && "no drafts left · waiting for drafts"}
                    {status !== "running" && status !== "offline" && !(status === "empty" && a.running) && stopReasonLabel(a.stopReason)}
                    {status === "offline" && "last seen " + ago(a.lastSeenAt, now)}
                  </div>
                </td>
                <td
                  className={cell + " num text-right " + (drafts === "zero" ? "font-semibold text-danger" : drafts === "low" ? "font-semibold text-warn" : "")}
                  title={
                    typeof a.remainingCount === "number"
                      ? "Exact, as of the extension's last look at the Drafts folder"
                      : drafts === "unknown"
                        ? "Not counted yet; the extension reports it once it has read the Drafts folder"
                        : "Approximate; the exact count follows once the extension has read the Drafts folder"
                  }
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
