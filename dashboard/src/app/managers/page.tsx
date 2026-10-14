import Link from "next/link";
import { asc, count, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { btn, btnDanger, btnPrimary, Card, input, td, th } from "@/components/ui";
import { createManager, deleteManager, renameManager } from "../actions";

export const dynamic = "force-dynamic";

export default async function ManagersPage() {
  await requireAdmin();

  const rows = await db
    .select({
      id: schema.managers.id,
      name: schema.managers.name,
      createdAt: schema.managers.createdAt,
      accounts: count(schema.accounts.id),
      running: sql<number>`count(*) filter (where ${schema.accounts.running})::int`,
      sentToday: sql<number>`coalesce(sum(${schema.accounts.sentToday}), 0)::int`,
      totalSent: sql<number>`coalesce(sum(${schema.accounts.totalSent}), 0)::int`,
    })
    .from(schema.managers)
    .leftJoin(schema.accounts, eq(schema.accounts.managerId, schema.managers.id))
    .groupBy(schema.managers.id)
    .orderBy(asc(schema.managers.name));

  const [unassigned] = await db
    .select({ n: count() })
    .from(schema.accounts)
    .where(sql`${schema.accounts.managerId} is null`);

  return (
    <div className="space-y-4">
      <Card title="New manager">
        <form action={createManager} className="flex gap-2">
          <input name="name" placeholder="Manager name" required maxLength={100} className={input + " w-64"} />
          <button className={btnPrimary}>Add</button>
        </form>
      </Card>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <table className="w-full border-collapse">
          <thead className="border-b border-zinc-200 dark:border-zinc-800">
            <tr>
              <th className={th}>Manager</th>
              <th className={th}>Accounts</th>
              <th className={th}>Running</th>
              <th className={th}>Sent today</th>
              <th className={th}>Sent total</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className="border-b border-zinc-100 last:border-0 dark:border-zinc-800/60">
                <td className={td}>
                  <form action={renameManager} className="flex items-center gap-1">
                    <input type="hidden" name="id" value={m.id} />
                    <input name="name" defaultValue={m.name} maxLength={100} className={input + " w-56 text-sm"} />
                    <button className={btn}>Rename</button>
                  </form>
                </td>
                <td className={td + " tabular-nums"}>
                  <Link href={"/?manager=" + m.id} className="hover:underline">{m.accounts}</Link>
                </td>
                <td className={td + " tabular-nums"}>{m.running}</td>
                <td className={td + " tabular-nums"}>{m.sentToday}</td>
                <td className={td + " tabular-nums"}>{m.totalSent}</td>
                <td className={td + " text-right"}>
                  <form action={deleteManager}>
                    <input type="hidden" name="id" value={m.id} />
                    <button className={btnDanger} title="Accounts under this manager become unassigned">Delete</button>
                  </form>
                </td>
              </tr>
            ))}
            <tr className="text-zinc-500">
              <td className={td}>Unassigned</td>
              <td className={td + " tabular-nums"}>
                <Link href="/?manager=none" className="hover:underline">{unassigned?.n ?? 0}</Link>
              </td>
              <td className={td} colSpan={4}></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
