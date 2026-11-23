import type { Account } from "@/db/schema";

export type Status = "running" | "stopped" | "empty" | "blocked" | "offline";

// A running install reports every minute, so three silent minutes still mean
// something is wrong. A paused one reports every five and has nothing to say
// in between (extension 1.6.21+): judging it by the running rule painted it
// offline for two minutes out of every five and raised an alert each time.
// Builds older than that beat every minute either way, which the longer rule
// covers too.
export const OFFLINE_AFTER_MS = 3 * 60 * 1000;
export const IDLE_OFFLINE_AFTER_MS = 12 * 60 * 1000;

// Two installs reporting the same address are only merged once one has been
// quiet this long. A live paused install is silent for five minutes at a
// time, so the old three-minute rule would fold it into the other one on
// every beat and both rows would be rebuilt forever.
export const SILENT_AFTER_MS = 30 * 60 * 1000;

export function offlineAfterMs(a: Pick<Account, "running">): number {
  return a.running ? OFFLINE_AFTER_MS : IDLE_OFFLINE_AFTER_MS;
}

// One rule for every place a status pill appears. "empty" can be a run that
// is still on and waiting for drafts (extension 1.6.3+) or, from older
// builds, a run that stopped for lack of them.
export function statusOf(
  a: Pick<Account, "running" | "stopReason" | "lastSeenAt">,
  now = Date.now(),
): Status {
  const seen = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
  if (!seen || now - seen > offlineAfterMs(a)) return "offline";
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
