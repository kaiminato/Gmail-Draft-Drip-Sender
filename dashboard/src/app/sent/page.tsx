import Link from "next/link";
import { asc, count, desc, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { fmtDateTime } from "@/lib/format";
import { CSV_FIELDS, DEFAULT_CSV_FIELDS, sentWhere } from "@/lib/sentQuery";
import { dashboardTz } from "@/lib/stats";
import { CsvExport } from "@/components/CsvExport";
import { ManagerFilter } from "@/components/ManagerFilter";
import { SearchFilter } from "@/components/SearchFilter";
import { SelectDelete } from "@/components/SelectDelete";
import { TierBadge } from "@/components/TierBadge";
import { btn, PageHeader, select, Stat, tableWrap, td, th } from "@/components/ui";
import { deleteSentMail } from "../actions";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 100;
const cell = td + " whitespace-nowrap";
const enc = encodeURIComponent;

// Every message sent, newest first, as recorded the moment its "sent" event
// arrived: sender, recipient, subject, and the manager and tier the account
// had then. Filtered like the accounts list (manager and free text), paged
// by 100. Rows can be deleted from here; the statistics, built from the
// events table, do not change.
export default async function SentPage({
  searchParams,
}: {
  searchParams: Promise<{ manager?: string; q?: string; page?: string }>;
}) {
  await requireAdmin();
  const { manager: filter = "", q = "", page: pageParam } = await searchParams;
  const page = Math.max(1, parseInt(pageParam || "1", 10) || 1);
  const tz = dashboardTz();

  const managers = await db.select().from(schema.managers).orderBy(asc(schema.managers.name));

  const where = sentWhere({ manager: filter, q });

  const dayStart = sql`date_trunc('day', now() at time zone ${tz})`;
  const local = sql`(${schema.sentMail.sentAt} at time zone ${tz})`;
  const [[{ n: matching }], [{ n: all }], [{ n: today }], [{ n: yesterday }], rows] = await Promise.all([
    db.select({ n: count() }).from(schema.sentMail).where(where),
    db.select({ n: count() }).from(schema.sentMail),
    db.select({ n: count() }).from(schema.sentMail).where(sql`${local} >= ${dayStart}`),
    db.select({ n: count() }).from(schema.sentMail).where(sql`${local} >= ${dayStart} - interval '1 day' and ${local} < ${dayStart}`),
    db
      .select()
      .from(schema.sentMail)
      .where(where)
      .orderBy(desc(schema.sentMail.sentAt), desc(schema.sentMail.receivedAt))
      .limit(PAGE_SIZE)
      .offset((page - 1) * PAGE_SIZE),
  ]);
  const pages = Math.max(1, Math.ceil(matching / PAGE_SIZE));

  const keepFor = (omit: "manager" | "q" | null) =>
    [filter && omit !== "manager" ? "manager=" + enc(filter) : "", q && omit !== "q" ? "q=" + enc(q) : ""].filter(Boolean).join("&");
  const pageHref = (p: number) => "/sent" + ((keepFor(null) || p > 1) ? "?" + [keepFor(null), p > 1 ? "page=" + p : ""].filter(Boolean).join("&") : "");

  return (
    <div className="space-y-4">
      <PageHeader title="Sent" description={"Every message sent, as reported by the extensions. Times and the day boundary use " + tz + "."}>
        <div className="flex flex-wrap items-center gap-2">
          <SearchFilter value={q} keep={keepFor("q")} path="/sent" placeholder="Filter by sender, recipient, subject, manager…" label="Filter sent mail" className="w-72 max-w-full" />
          <ManagerFilter value={filter} managers={managers} className={select} keep={keepFor("manager")} path="/sent" />
          <CsvExport
            manager={filter}
            q={q}
            matching={matching}
            fields={CSV_FIELDS.map((f) => ({ key: f.key, label: f.label, checked: DEFAULT_CSV_FIELDS.includes(f.key) }))}
          />
        </div>
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Sent today" value={today} tone="accent" sub={"since 00:00 " + tz} />
        <Stat label="Yesterday" value={yesterday} />
        <Stat label="All time" value={all} />
        <Stat label="Matching" value={matching} sub={pages > 1 ? "page " + page + " of " + pages : undefined} />
      </div>

      {/* The delete form holds nothing itself; row boxes point at it with form="del". */}
      <form id="del" action={deleteSentMail} />
      <SelectDelete shown={rows.length} total={matching} what="entries" />

      <div className={tableWrap}>
        <table className="w-full border-collapse text-sm">
          <thead className="border-b border-line">
            <tr>
              <th className={th + " w-8"}></th>
              <th className={th}>Sent</th>
              <th className={th}>From</th>
              <th className={th}>To</th>
              <th className={th}>Subject</th>
              <th className={th}>Manager</th>
              <th className={th}>Mode</th>
              <th className={th}>Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-10 text-center text-sm text-muted">
                  {all === 0 ? "Nothing sent yet. Messages appear here as the extensions report them." : "Nothing matches this filter."}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line/60 last:border-0">
                <td className={cell}>
                  <input type="checkbox" name="ids" value={r.id} form="del" aria-label={"Select message to " + (r.recipient || "unknown")} />
                </td>
                <td className={cell + " num text-xs text-muted"} title={new Date(r.sentAt).toISOString()}>{fmtDateTime(r.sentAt, tz)}</td>
                <td className={cell}>
                  {r.accountId ? (
                    <Link href={"/accounts/" + r.accountId} className="hover:text-accent">{r.sender || "unknown"}</Link>
                  ) : (
                    <span title="The account was removed">{r.sender || "unknown"}</span>
                  )}
                </td>
                <td className={td + " max-w-[18rem] truncate"} title={r.recipient || ""}>
                  {r.recipient || <span className="text-muted">—</span>}
                </td>
                <td className={td + " max-w-[24rem] truncate"} title={r.subject || ""}>
                  {r.subject || <span className="text-muted">(no subject)</span>}
                </td>
                <td className={cell}>{r.managerName || <span className="text-muted">—</span>}</td>
                <td className={cell}><TierBadge tier={r.tier} /></td>
                <td className={cell + " text-xs"}>
                  {r.late ? <span className="text-warn" title="The send was confirmed from the Drafts list after the compose timed out">confirmed late</span> : <span className="text-muted">—</span>}
                  {r.recipientCount > 1 && <span className="text-muted"> · {r.recipientCount} recipients</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-muted">
          <span>Page {page} of {pages}</span>
          <div className="flex gap-2">
            {page > 1 ? <Link href={pageHref(page - 1)} className={btn}>Newer</Link> : <span className={btn + " pointer-events-none opacity-40"}>Newer</span>}
            {page < pages ? <Link href={pageHref(page + 1)} className={btn}>Older</Link> : <span className={btn + " pointer-events-none opacity-40"}>Older</span>}
          </div>
        </div>
      )}
    </div>
  );
}
