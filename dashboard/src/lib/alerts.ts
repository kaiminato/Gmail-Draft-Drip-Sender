import type { DraftsLevel, Status } from "./status";

// What the alert watcher compares between two polls. Kept small: it is
// polled every half minute and stored in the browser.
export type AccountSnap = {
  id: string;
  name: string;
  status: Status;
  drafts: DraftsLevel;
  count: number | null;
};

export type AlertKind = "offline" | "drafts" | "blocked";

export type Alert = {
  id: string; // unique per alert instance
  kind: AlertKind;
  accountId: string;
  name: string;
  title: string;
  body: string;
  at: number;
};

const isLow = (d: DraftsLevel) => d === "low" || d === "zero";

// The changes worth telling someone about between the previous picture and
// the current one. An account seen for the first time sets a baseline and
// raises nothing.
export function diffSnapshots(prev: AccountSnap[], cur: AccountSnap[], now = Date.now()): Alert[] {
  const before = new Map(prev.map((a) => [a.id, a]));
  const out: Alert[] = [];
  for (const a of cur) {
    const p = before.get(a.id);
    if (!p) continue;
    if (p.status !== "offline" && a.status === "offline") {
      out.push({ id: a.id + ":offline:" + now, kind: "offline", accountId: a.id, name: a.name, at: now,
        title: "Went offline", body: a.name + " stopped reporting." });
    }
    if (p.status !== "blocked" && a.status === "blocked") {
      out.push({ id: a.id + ":blocked:" + now, kind: "blocked", accountId: a.id, name: a.name, at: now,
        title: "Blocked by Gmail", body: a.name + " was stopped by a block notice." });
    }
    const nowLow = isLow(a.drafts);
    const wasLow = isLow(p.drafts);
    const ranOut = a.drafts === "zero" && p.drafts !== "zero";
    if ((nowLow && !wasLow) || ranOut) {
      const left = a.drafts === "zero" ? "has no drafts left" : "is down to " + (a.count ?? "fewer than 5") + " drafts";
      out.push({ id: a.id + ":drafts:" + now, kind: "drafts", accountId: a.id, name: a.name, at: now,
        title: a.drafts === "zero" ? "Out of drafts" : "Low on drafts", body: a.name + " " + left + "." });
    }
  }
  return out;
}
