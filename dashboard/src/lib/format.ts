// Small formatting helpers shared by the pages. All server-safe.

// Pages are rendered once per request on the server, so reading the clock
// during render is fine; this just keeps the purity lint rule quiet.
export const nowMs = (): number => Date.now();

export function ago(date: Date | string | null | undefined, now = Date.now()): string {
  if (!date) return "never";
  const t = new Date(date).getTime();
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return s + "s ago";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h ago";
  return Math.floor(h / 24) + "d ago";
}

export function inFuture(date: Date | string | null | undefined, now = Date.now()): string {
  if (!date) return "";
  const t = new Date(date).getTime();
  const s = Math.round((t - now) / 1000);
  if (s <= 0) return "any moment";
  const m = Math.floor(s / 60);
  if (m < 60) return "in " + m + "m";
  const h = Math.floor(m / 60);
  if (h < 48) return "in " + h + "h " + (m % 60) + "m";
  return "in " + Math.floor(h / 24) + "d";
}

// A planned send that passed a while ago with nothing sent since: the
// extension lost its schedule (it re-arms on its next heartbeat).
export const OVERDUE_AFTER_MS = 30 * 60 * 1000;
export function overdue(nextSendAt: Date | string | null | undefined, now = Date.now()): boolean {
  if (!nextSendAt) return false;
  return now - new Date(nextSendAt).getTime() > OVERDUE_AFTER_MS;
}

export function fmtDateTime(date: Date | string | null | undefined, tz: string): string {
  if (!date) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(date));
  } catch {
    return new Date(date).toISOString().slice(0, 16).replace("T", " ");
  }
}

export function fmtInterval(min: number, max: number): string {
  const f = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return f(min) + "–" + f(max) + " min";
}

// Numeric dotted versions ("1.4.0"); anything unparsable sorts lowest.
export function cmpVersion(a: string | null | undefined, b: string | null | undefined): number {
  const parse = (v: string | null | undefined) =>
    String(v || "").split(".").map((p) => parseInt(p, 10) || 0);
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

export function stopReasonLabel(reason: string | null | undefined): string {
  switch (reason) {
    case "user": return "stopped by user";
    case "admin": return "stopped from dashboard";
    case "empty": return "no drafts left";
    case "blocked": return "blocked by Gmail";
    case "failures": return "too many failures";
    case "daily_cap": return "target reached for today";
    case "signin": return "needs Gmail sign-in";
    default: return reason || "";
  }
}
