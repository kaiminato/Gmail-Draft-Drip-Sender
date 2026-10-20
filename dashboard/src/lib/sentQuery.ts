import { and, eq, ilike, inArray, isNull, or, type SQL } from "drizzle-orm";
import { schema } from "@/db";
import type { SentMail } from "@/db/schema";
import { filterWords } from "./filter";

// The sent-mail log's filter, shared by the page and the CSV export so the
// file holds exactly the rows the page would show: the manager filter, the
// free-text words (each must appear in sender, recipient, subject or
// manager name), and optionally a fixed set of ids (the ticked rows).
export function sentWhere(opts: { manager?: string; q?: string; ids?: string[] }): SQL | undefined {
  const conds: SQL[] = [];
  if (opts.manager === "none") conds.push(isNull(schema.sentMail.managerId));
  else if (opts.manager) conds.push(eq(schema.sentMail.managerId, opts.manager));
  for (const w of filterWords(opts.q)) {
    const like = "%" + w.replace(/[%_\\]/g, (c) => "\\" + c) + "%";
    conds.push(
      or(
        ilike(schema.sentMail.sender, like),
        ilike(schema.sentMail.recipient, like),
        ilike(schema.sentMail.subject, like),
        ilike(schema.sentMail.managerName, like),
      )!,
    );
  }
  if (opts.ids && opts.ids.length) conds.push(inArray(schema.sentMail.id, opts.ids));
  return conds.length ? and(...conds) : undefined;
}

/* ---------- CSV columns ---------- */

export type CsvField = { key: string; label: string; value: (r: SentMail, tz: string) => string };

// "2026-10-21 00:13:05" in the dashboard zone; sorts as text, opens in Excel.
export function csvDateTime(date: Date | string, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(date));
    const p: Record<string, string> = {};
    for (const x of parts) p[x.type] = x.value;
    return `${p.year}-${p.month}-${p.day} ${(p.hour === "24" ? "00" : p.hour)}:${p.minute}:${p.second}`;
  } catch {
    return new Date(date).toISOString();
  }
}

export const CSV_FIELDS: CsvField[] = [
  { key: "sent_at", label: "Sent at", value: (r, tz) => csvDateTime(r.sentAt, tz) },
  { key: "sender", label: "Sender", value: (r) => r.sender ?? "" },
  { key: "recipient", label: "Recipient", value: (r) => r.recipient ?? "" },
  { key: "recipients", label: "Recipient count", value: (r) => String(r.recipientCount) },
  { key: "subject", label: "Subject", value: (r) => r.subject ?? "" },
  { key: "manager", label: "Manager", value: (r) => r.managerName ?? "" },
  { key: "tier", label: "Volume tier", value: (r) => r.tier ?? "" },
  { key: "late", label: "Confirmed late", value: (r) => (r.late ? "yes" : "no") },
  { key: "sent_at_utc", label: "Sent at (UTC)", value: (r) => new Date(r.sentAt).toISOString() },
  { key: "id", label: "Event id", value: (r) => r.id },
];

export const DEFAULT_CSV_FIELDS = ["sent_at", "sender", "recipient", "subject", "manager", "tier"];

// One CSV cell: quoted when it needs to be, quotes doubled, and a leading
// formula character neutralised so a subject like "=1+1" stays text in a
// spreadsheet.
export function csvCell(v: string): string {
  let s = v.replace(/\r?\n/g, " ");
  if (/^[=+\-@\t]/.test(s)) s = "'" + s;
  return /[",;\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCsv(rows: SentMail[], fields: CsvField[], tz: string): string {
  const head = fields.map((f) => csvCell(f.key === "sent_at" ? f.label + " (" + tz + ")" : f.label)).join(",");
  const lines = rows.map((r) => fields.map((f) => csvCell(f.value(r, tz))).join(","));
  // The byte-order mark makes Excel read UTF-8 (names, subjects) correctly.
  return "﻿" + [head, ...lines].join("\r\n") + "\r\n";
}
