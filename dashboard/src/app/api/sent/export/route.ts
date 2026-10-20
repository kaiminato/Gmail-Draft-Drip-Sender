import { desc } from "drizzle-orm";
import { db, schema } from "@/db";
import { currentAdmin } from "@/lib/admin";
import { CSV_FIELDS, DEFAULT_CSV_FIELDS, csvDateTime, sentWhere, toCsv } from "@/lib/sentQuery";
import { dashboardTz } from "@/lib/stats";

export const dynamic = "force-dynamic";

const MAX_ROWS = 100000;

// The Sent page's CSV download. A plain form post (so the browser saves the
// file and the page stays put) carrying the page's filter, the chosen
// columns, and, when rows were ticked, their ids. Admin session required.
export async function POST(req: Request) {
  if (!(await currentAdmin())) return new Response("unauthorized", { status: 401 });

  const form = await req.formData();
  const str = (k: string) => {
    const v = form.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const wanted = form.getAll("fields").filter((v): v is string => typeof v === "string");
  const keys = wanted.length ? wanted : DEFAULT_CSV_FIELDS;
  const fields = CSV_FIELDS.filter((f) => keys.includes(f.key));
  if (!fields.length) return new Response("no columns chosen", { status: 400 });
  const ids = form.getAll("ids").filter((v): v is string => typeof v === "string" && v.length > 0);

  const tz = dashboardTz();
  const rows = await db
    .select()
    .from(schema.sentMail)
    .where(sentWhere({ manager: str("manager"), q: str("q"), ids }))
    .orderBy(desc(schema.sentMail.sentAt), desc(schema.sentMail.receivedAt))
    .limit(MAX_ROWS);

  const stamp = csvDateTime(new Date(), tz).slice(0, 16).replace(/[: ]/g, "-");
  const name = "sent-mail-" + stamp + (ids.length ? "-selected" : str("manager") || str("q") ? "-filtered" : "") + ".csv";
  return new Response(toCsv(rows, fields, tz), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="' + name + '"',
      "Cache-Control": "no-store",
    },
  });
}
