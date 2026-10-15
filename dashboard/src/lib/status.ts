import type { Account } from "@/db/schema";

export type Status = "running" | "stopped" | "empty" | "blocked" | "offline";

export const OFFLINE_AFTER_MS = 3 * 60 * 1000;

// One rule for every place a status pill appears.
export function statusOf(
  a: Pick<Account, "running" | "stopReason" | "lastSeenAt">,
  now = Date.now(),
): Status {
  const seen = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
  if (!seen || now - seen > OFFLINE_AFTER_MS) return "offline";
  if (a.stopReason === "blocked") return "blocked";
  if (a.stopReason === "empty") return "empty";
  if (a.running) return "running";
  return "stopped";
}

export const STATUS_LABEL: Record<Status, string> = {
  running: "Running",
  stopped: "Stopped",
  empty: "Empty",
  blocked: "Blocked",
  offline: "Offline",
};

export const STATUS_CLASS: Record<Status, string> = {
  running: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  stopped: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  empty: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  blocked: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  offline: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
};

// Drafts-left level: fewer than LOW_DRAFTS is worth a nudge, zero is urgent.
export const LOW_DRAFTS = 5;
export type DraftsLevel = "zero" | "low" | "ok" | "unknown";
export function draftsLevel(count: number | null | undefined, bucket?: string): DraftsLevel {
  if (typeof count === "number" && count >= 0) return count === 0 ? "zero" : count < LOW_DRAFTS ? "low" : "ok";
  if (bucket === "none") return "zero";
  if (bucket === "1-10" || bucket === "10+") return "ok";
  return "unknown";
}

export const BUCKET_LABEL: Record<string, string> = {
  none: "None",
  "1-10": "1~10",
  "10+": "10+",
  unknown: "—",
};
