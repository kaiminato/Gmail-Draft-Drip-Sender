import Link from "next/link";
import { asc, count, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireAdmin } from "@/lib/admin";
import { btn, btnDanger, btnPrimary, Card, input, PageHeader, tableWrap, td, th } from "@/components/ui";
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
      <PageHeader title="Managers" description="Labels to group accounts by. Managers do not sign in.">
        <form action={createManager} className="flex gap-2">
          <input name="name" placeholder="New manager name" required maxLength={100} className={input + " w-56"} />
          <button className={btnPrimary}>Add</button>
        </form>
      </PageHeader>

      <div className={tableWrap}>
        <table className="w-full border-collapse">
          <thead className="border-b border-line">
            <tr>
              <th className={th}>Manager</th>
              <th className={th + " text-right"}>Accounts</th>
              <th className={th + " text-right"}>Running</th>
              <th className={th + " text-right"}>Sent today</th>
              <th className={th + " text-right"}>Sent total</th>
              <th className={th}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className="border-b border-line/60 last:border-0">
                <td className={td}>
                  <form action={renameManager} className="flex items-center gap-1">
                    <input type="hidden" name="id" value={m.id} />
                    <input name="name" defaultValue={m.name} maxLength={100} className={input + " w-56"} />
                    <button className={btn}>Rename</button>
                  </form>
                </td>
                <td className={td + " num text-right"}>
                  <Link href={"/?manager=" + m.id} className="hover:text-accent">{m.accounts}</Link>
                </td>
                <td className={td + " num text-right"}>{m.running}</td>
                <td className={td + " num text-right"}>{m.sentToday}</td>
                <td className={td + " num text-right"}>{m.totalSent}</td>
                <td className={td + " text-right"}>
                  <form action={deleteManager}>
                    <input type="hidden" name="id" value={m.id} />
                    <button className={btnDanger} title="Accounts under this manager become unassigned">Delete</button>
                  </form>
                </td>
              </tr>
            ))}
            <tr className="text-muted">
              <td className={td}>Unassigned</td>
              <td className={td + " num text-right"}>
                <Link href="/?manager=none" className="hover:text-accent">{unassigned?.n ?? 0}</Link>
              </td>
              <td className={td} colSpan={4}></td>
            </tr>
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <Card>
          <p className="text-sm text-muted">No managers yet. Add one above, then assign accounts from the Accounts table.</p>
        </Card>
      )}
    </div>
  );
}
