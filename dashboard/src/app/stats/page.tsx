import Link from "next/link";
import { requireAdmin } from "@/lib/admin";
import { counts, dailySeries, dashboardTz, overallStats, statsByAccount, statsByManager } from "@/lib/stats";
import { AutoRefresh } from "@/components/AutoRefresh";
import { Card, Stat, td, th } from "@/components/ui";

export const dynamic = "force-dynamic";

function Bars({ points }: { points: { day: string; sent: number; blocked: number }[] }) {
  const max = Math.max(1, ...points.map((p) => p.sent));
  return (
    <div className="flex h-40 items-end gap-[3px]">
      {points.map((p) => (
        <div key={p.day} className="group relative flex h-full flex-1 flex-col justify-end" title={p.day + ": " + p.sent + " sent" + (p.blocked ? ", " + p.blocked + " blocked" : "")}>
          <div
            className={"w-full rounded-t " + (p.blocked ? "bg-red-500/80" : "bg-blue-500/80")}
            style={{ height: Math.round((p.sent / max) * 100) + "%", minHeight: p.sent ? 2 : 0 }}
          />
        </div>
      ))}
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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Sent today" value={sent.today} />
        <Stat label="Sent this week" value={sent.week} sub="Monday to now" />
        <Stat label="Sent this month" value={sent.month} />
        <Stat label="Sent in total" value={sent.total} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Blocks" value={blocked.total} sub={blocked.today + " today · " + blocked.week + " this week · " + blocked.month + " this month"} />
        <Stat label="Bounces" value={bounce.total} sub={bounce.today + " today · " + bounce.week + " this week"} />
        <Stat label="Failed cycles" value={failed.total} sub={failed.today + " today · " + failed.week + " this week"} />
        <Stat
          label="Bounce rate"
          value={sent.total ? ((bounce.total / sent.total) * 100).toFixed(1) + "%" : "—"}
          sub="bounces per send, all time"
        />
      </div>

      <Card title="Sends per day, last 30 days">
        <Bars points={series} />
        <div className="mt-1 flex justify-between text-xs text-zinc-500">
          <span>{series[0]?.day}</span>
          <span>red = a day with a block notice</span>
          <span>{series[series.length - 1]?.day}</span>
        </div>
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
      <p className="text-xs text-zinc-500">Day, week and month boundaries use {tz}. Set DASHBOARD_TZ to change it.</p>
    </div>
  );
}

function StatsTable({
  rows,
}: {
  rows: { key: string; label: string; href: string; types: Record<string, { today: number; week: number; month: number; total: number }> }[];
}) {
  if (!rows.length) return <p className="text-sm text-zinc-500">Nothing recorded yet.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead className="border-b border-zinc-200 dark:border-zinc-800">
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
            return (
              <tr key={r.key} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                <td className={td}><Link href={r.href} className="hover:underline">{r.label}</Link></td>
                <td className={td + " text-right tabular-nums"}>{s.today}</td>
                <td className={td + " text-right tabular-nums"}>{s.week}</td>
                <td className={td + " text-right tabular-nums"}>{s.month}</td>
                <td className={td + " text-right tabular-nums font-medium"}>{s.total}</td>
                <td className={td + " text-right tabular-nums"}>{counts(r.types, "blocked").total}</td>
                <td className={td + " text-right tabular-nums"}>{counts(r.types, "bounce").total}</td>
                <td className={td + " text-right tabular-nums"}>{counts(r.types, "failed").total}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
