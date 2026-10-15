import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { counts, dailySeries, dashboardTz, overallStats, statsByAccount, statsByManager } from "@/lib/stats";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Card, PageHeader, Stat, td, th } from "@/components/ui";

export const dynamic = "force-dynamic";

function Bars({ points }: { points: { day: string; sent: number; blocked: number; bounce: number }[] }) {
  const max = Math.max(1, ...points.map((p) => p.sent));
  const ticks = [max, Math.round(max / 2), 0];
  return (
    <div className="flex gap-3">
      <div className="num flex h-44 flex-col justify-between text-[10px] text-muted">
        {ticks.map((t) => <span key={t}>{t}</span>)}
      </div>
      <div className="flex-1">
        <div className="flex h-44 items-end gap-[3px] border-b border-line">
          {points.map((p) => (
            <div
              key={p.day}
              className="flex h-full flex-1 flex-col justify-end"
              title={p.day + ": " + p.sent + " sent" + (p.bounce ? ", " + p.bounce + " bounced" : "") + (p.blocked ? ", " + p.blocked + " blocked" : "")}
            >
              <div
                className={"w-full rounded-t-sm " + (p.blocked ? "bg-danger/80" : "bg-accent/70")}
                style={{ height: Math.round((p.sent / max) * 100) + "%", minHeight: p.sent ? 2 : 0 }}
              />
            </div>
          ))}
        </div>
        <div className="num mt-1 flex justify-between text-[10px] text-muted">
          <span>{points[0]?.day}</span>
          <span>{points[Math.floor(points.length / 2)]?.day}</span>
          <span>{points[points.length - 1]?.day}</span>
        </div>
      </div>
    </div>
  );
}

export default async function StatsPage() {
  await requireAdmin();
  const tz = dashboardTz();
  const [overall, byManager, byAccount, series] = await Promise.all([
    overallStats(tz),
    statsByManager(tz),
    statsByAccount(tz),
    dailySeries(tz, 30),
  ]);

  const sent = counts(overall, "sent");
  const blocked = counts(overall, "blocked");
  const bounce = counts(overall, "bounce");
  const failed = counts(overall, "failed");

  return (
    <div className="space-y-4">
      <AutoRefresh seconds={60} />
      <PageHeader title="Stats" description={"Built from every reported event. Day, week and month boundaries use " + tz + "."} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sent today" value={sent.today} tone="accent" />
        <Stat label="Sent this week" value={sent.week} sub="Monday to now" />
        <Stat label="Sent this month" value={sent.month} />
        <Stat label="Sent in total" value={sent.total} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Blocks" value={blocked.total} tone={blocked.total ? "danger" : undefined} sub={blocked.today + " today · " + blocked.week + " week · " + blocked.month + " month"} />
        <Stat label="Bounces" value={bounce.total} tone={bounce.total ? "warn" : undefined} sub={bounce.today + " today · " + bounce.week + " week"} />
        <Stat label="Failed cycles" value={failed.total} sub={failed.today + " today · " + failed.week + " week"} />
        <Stat
          label="Bounce rate"
          value={sent.total ? ((bounce.total / sent.total) * 100).toFixed(1) + "%" : "—"}
          sub="bounces per send, all time"
          tone={sent.total && bounce.total / sent.total > 0.05 ? "warn" : undefined}
        />
      </div>

      <Card title="Sends per day, last 30 days" aside={<span className="text-xs text-muted">red bar = a day with a block notice</span>}>
        <Bars points={series} />
      </Card>

      <Card title="By manager">
        <StatsTable
          rows={byManager.map((m) => ({
            key: m.managerId ?? "none",
            label: m.name,
            href: "/?manager=" + (m.managerId ?? "none"),
            types: m.types,
          }))}
        />
      </Card>

      <Card title="By account">
        <StatsTable
          rows={byAccount.map((a) => ({
            key: a.accountId,
            label: a.email || "unknown",
            href: "/accounts/" + a.accountId,
            types: a.types,
          }))}
        />
      </Card>
    </div>
  );
}

function StatsTable({
  rows,
}: {
  rows: { key: string; label: string; href: string; types: Record<string, { today: number; week: number; month: number; total: number }> }[];
}) {
  if (!rows.length) return <p className="text-sm text-muted">Nothing recorded yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead className="border-b border-line">
          <tr>
            <th className={th}></th>
            <th className={th + " text-right"}>Today</th>
            <th className={th + " text-right"}>Week</th>
            <th className={th + " text-right"}>Month</th>
            <th className={th + " text-right"}>Total</th>
            <th className={th + " text-right"}>Blocks</th>
            <th className={th + " text-right"}>Bounces</th>
            <th className={th + " text-right"}>Failed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const s = counts(r.types, "sent");
            const b = counts(r.types, "blocked").total;
            return (
              <tr key={r.key} className="border-b border-line/60 last:border-0">
                <td className={td}><Link href={r.href} className="hover:text-accent">{r.label}</Link></td>
                <td className={td + " num text-right"}>{s.today}</td>
                <td className={td + " num text-right"}>{s.week}</td>
                <td className={td + " num text-right"}>{s.month}</td>
                <td className={td + " num text-right font-medium"}>{s.total}</td>
                <td className={td + " num text-right " + (b ? "text-danger" : "")}>{b}</td>
                <td className={td + " num text-right"}>{counts(r.types, "bounce").total}</td>
                <td className={td + " num text-right"}>{counts(r.types, "failed").total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
