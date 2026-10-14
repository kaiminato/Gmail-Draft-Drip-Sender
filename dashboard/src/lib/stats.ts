import { sql } from "drizzle-orm";
import { db } from "@/db";

export type Counts = { today: number; week: number; month: number; total: number };
export type TypeCounts = Record<string, Counts>;

const EMPTY: Counts = { today: 0, week: 0, month: 0, total: 0 };

export function counts(tc: TypeCounts | undefined, type: string): Counts {
  return (tc && tc[type]) || EMPTY;
}

// "Today", "this week" and "this month" only mean something in a timezone.
// It comes from DASHBOARD_TZ (an IANA name), with UTC as the fallback.
export function dashboardTz(override?: string | null): string {
  const want = (override || process.env.DASHBOARD_TZ || "UTC").trim();
  try {
    const known = Intl.supportedValuesOf("timeZone");
    return known.includes(want) || want === "UTC" ? want : "UTC";
  } catch {
    return "UTC";
  }
}

type TypeRow = { type: string; today: number; week: number; month: number; total: number };

function fold(rows: Array<TypeRow & { key?: string | null; name?: string | null }>) {
  const byKey = new Map<string, { name: string; types: TypeCounts }>();
  for (const r of rows) {
    const key = r.key ?? "";
    let bucket = byKey.get(key);
    if (!bucket) {
      bucket = { name: r.name ?? "", types: {} };
      byKey.set(key, bucket);
    }
    bucket.types[r.type] = { today: r.today, week: r.week, month: r.month, total: r.total };
  }
  return byKey;
}

// Totals per event type across every account.
export async function overallStats(tz: string): Promise<TypeCounts> {
  const res = await db.execute<TypeRow>(sql`
    with b as (
      select date_trunc('day',   now() at time zone ${tz}) as day,
             date_trunc('week',  now() at time zone ${tz}) as week,
             date_trunc('month', now() at time zone ${tz}) as month
    )
    select e.type,
      count(*) filter (where (e.occurred_at at time zone ${tz}) >= b.day)::int   as today,
      count(*) filter (where (e.occurred_at at time zone ${tz}) >= b.week)::int  as week,
      count(*) filter (where (e.occurred_at at time zone ${tz}) >= b.month)::int as month,
      count(*)::int as total
    from events e, b
    group by e.type
  `);
  const out: TypeCounts = {};
  for (const r of res.rows) out[r.type] = { today: r.today, week: r.week, month: r.month, total: r.total };
  return out;
}

export type ManagerStats = { managerId: string | null; name: string; types: TypeCounts };

// The same numbers split by manager. Accounts with no manager are grouped as
// "Unassigned" so nothing goes missing from the table.
export async function statsByManager(tz: string): Promise<ManagerStats[]> {
  const res = await db.execute<TypeRow & { key: string | null; name: string | null }>(sql`
    with b as (
      select date_trunc('day',   now() at time zone ${tz}) as day,
             date_trunc('week',  now() at time zone ${tz}) as week,
             date_trunc('month', now() at time zone ${tz}) as month
    )
    select m.id::text as key, m.name as name, e.type,
      count(*) filter (where (e.occurred_at at time zone ${tz}) >= b.day)::int   as today,
      count(*) filter (where (e.occurred_at at time zone ${tz}) >= b.week)::int  as week,
      count(*) filter (where (e.occurred_at at time zone ${tz}) >= b.month)::int as month,
      count(*)::int as total
    from events e
    join accounts a on a.id = e.account_id
    left join managers m on m.id = a.manager_id, b
    group by m.id, m.name, e.type
  `);
  const folded = fold(res.rows);
  const out: ManagerStats[] = [];
  for (const [key, v] of folded) {
    out.push({ managerId: key || null, name: v.name || "Unassigned", types: v.types });
  }
  out.sort((a, b) => counts(b.types, "sent").total - counts(a.types, "sent").total);
  return out;
}

export type AccountStats = { accountId: string; email: string | null; types: TypeCounts };

export async function statsByAccount(tz: string): Promise<AccountStats[]> {
  const res = await db.execute<TypeRow & { key: string; name: string | null }>(sql`
    with b as (
      select date_trunc('day',   now() at time zone ${tz}) as day,
             date_trunc('week',  now() at time zone ${tz}) as week,
             date_trunc('month', now() at time zone ${tz}) as month
    )
    select a.id::text as key, a.email as name, e.type,
      count(*) filter (where (e.occurred_at at time zone ${tz}) >= b.day)::int   as today,
      count(*) filter (where (e.occurred_at at time zone ${tz}) >= b.week)::int  as week,
      count(*) filter (where (e.occurred_at at time zone ${tz}) >= b.month)::int as month,
      count(*)::int as total
    from events e
    join accounts a on a.id = e.account_id, b
    group by a.id, a.email, e.type
  `);
  const folded = fold(res.rows);
  const out: AccountStats[] = [];
  for (const [key, v] of folded) out.push({ accountId: key, email: v.name || null, types: v.types });
  out.sort((a, b) => counts(b.types, "sent").total - counts(a.types, "sent").total);
  return out;
}

export type DayPoint = { day: string; sent: number; blocked: number; bounce: number; failed: number };

// One point per calendar day for the last `days` days, including empty days.
export async function dailySeries(tz: string, days = 30): Promise<DayPoint[]> {
  const res = await db.execute<DayPoint>(sql`
    with d as (
      select generate_series(
        date_trunc('day', now() at time zone ${tz}) - make_interval(days => ${days - 1}),
        date_trunc('day', now() at time zone ${tz}),
        interval '1 day') as day
    )
    select to_char(d.day, 'YYYY-MM-DD') as day,
      count(e.id) filter (where e.type = 'sent')::int    as sent,
      count(e.id) filter (where e.type = 'blocked')::int as blocked,
      count(e.id) filter (where e.type = 'bounce')::int  as bounce,
      count(e.id) filter (where e.type = 'failed')::int  as failed
    from d
    left join events e on date_trunc('day', e.occurred_at at time zone ${tz}) = d.day
    group by d.day
    order by d.day
  `);
  return res.rows;
}
