"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { diffSnapshots, type AccountSnap, type Alert } from "@/lib/alerts";

const POLL_MS = 30000;
const TOAST_MS = 60000;
const SNAP_KEY = "alerts-snapshot";

function loadSnapshot(): AccountSnap[] {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    return raw ? (JSON.parse(raw) as AccountSnap[]) : [];
  } catch {
    return [];
  }
}

function saveSnapshot(snap: AccountSnap[]) {
  try {
    localStorage.setItem(SNAP_KEY, JSON.stringify(snap));
  } catch {
    // Storage blocked: the baseline lives in memory for this page only.
  }
}

function desktopNotify(alerts: Alert[], go: (href: string) => void) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  for (const a of alerts) {
    try {
      const n = new Notification(a.title, { body: a.body, tag: a.accountId + ":" + a.kind });
      // Bring the dashboard forward on the accounts list with this row
      // scrolled to and marked (the filter is dropped so the row is there).
      n.onclick = () => {
        window.focus();
        go("/?highlight=" + encodeURIComponent(a.accountId));
      };
    } catch {
      // Some browsers only allow notifications from a worker; the toast remains.
    }
  }
}

const TONE: Record<Alert["kind"], string> = {
  offline: "border-l-warn",
  drafts: "border-l-warn",
  blocked: "border-l-danger",
};

// Polls the account summary every half minute, compares it with the last
// picture (kept in localStorage so a reload does not lose it), and shows a
// toast for every change worth knowing: an account going offline, getting
// blocked, or dropping under 5 drafts. With permission, the same goes out
// as a desktop notification, so it reaches you with the dashboard in a
// background tab. Mounted once in the layout, so it runs on every page.
export function AlertWatcher() {
  const [toasts, setToasts] = useState<Alert[]>([]);
  const router = useRouter();

  useEffect(() => {
    let prev = loadSnapshot();
    let stopped = false;
    const tick = async () => {
      try {
        const r = await fetch("/api/accounts/summary", { cache: "no-store" });
        if (!r.ok || stopped) return;
        const data = (await r.json()) as { accounts: AccountSnap[] };
        const alerts = diffSnapshots(prev, data.accounts);
        prev = data.accounts;
        saveSnapshot(prev);
        if (alerts.length) {
          setToasts((t) => [...alerts, ...t].slice(0, 8));
          desktopNotify(alerts, (href) => router.push(href));
          for (const a of alerts) {
            setTimeout(() => setToasts((t) => t.filter((x) => x.id !== a.id)), TOAST_MS);
          }
        }
      } catch {
        // Offline or signed out: try again next tick.
      }
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [router]);

  if (!toasts.length) return null;
  return (
    <div className="fixed bottom-4 right-4 z-40 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2" role="status" aria-live="polite">
      {toasts.map((a) => (
        <div key={a.id} className={"flex items-start gap-2 rounded-lg border border-line border-l-4 bg-panel px-3 py-2 shadow-2xl shadow-black/40 " + TONE[a.kind]}>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold">{a.title}</div>
            <Link href={"/?highlight=" + encodeURIComponent(a.accountId)} className="block truncate text-xs text-muted hover:text-fg" title={a.body + " Click to show the row."}>
              {a.body}
            </Link>
          </div>
          <button
            type="button"
            onClick={() => setToasts((t) => t.filter((x) => x.id !== a.id))}
            className="rounded px-1 text-xs text-muted hover:bg-panel-2 hover:text-fg"
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/* ---------- desktop permission ---------- */

type Perm = "unsupported" | "default" | "granted" | "denied";
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};
const readPerm = (): Perm => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);
const serverPerm = (): Perm => "default";

// The sidebar button that turns desktop notifications on for this browser.
// The browser only grants permission from a click, which is why it is a
// button and not automatic.
export function DesktopAlertsButton() {
  const perm = useSyncExternalStore(subscribe, readPerm, serverPerm);
  if (perm === "unsupported") return null;

  const ask = async () => {
    if (perm !== "default") return;
    try {
      await Notification.requestPermission();
    } finally {
      listeners.forEach((cb) => cb());
    }
  };

  const label = perm === "granted" ? "Desktop alerts on" : perm === "denied" ? "Alerts blocked in browser" : "Enable desktop alerts";
  const title =
    perm === "granted"
      ? "You get a desktop notification when an account goes offline, is blocked, or drops under 5 drafts."
      : perm === "denied"
        ? "Notifications were blocked for this site; allow them in the browser's site settings."
        : "Get a desktop notification when an account goes offline, is blocked, or drops under 5 drafts.";

  return (
    <button
      type="button"
      onClick={ask}
      disabled={perm !== "default"}
      title={title}
      aria-label={label}
      className={
        "flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors " +
        (perm === "default" ? "text-muted hover:bg-panel-2 hover:text-fg" : perm === "granted" ? "text-accent" : "text-muted/60")
      }
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
      <span className="nav-label hidden truncate md:inline">{label}</span>
    </button>
  );
}
