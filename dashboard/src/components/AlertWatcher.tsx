"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import { diffSnapshots, type AccountSnap, type Alert } from "@/lib/alerts";
import { btnPrimary } from "@/components/ui";

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

// The Settings-page control that turns desktop notifications on for this
// browser. The browser only grants permission from a click, which is why it
// is a button and not automatic, and the permission is per browser, so each
// computer the dashboard is watched from enables it once.
export function DesktopAlertsSetting() {
  const perm = useSyncExternalStore(subscribe, readPerm, serverPerm);

  const ask = async () => {
    if (perm !== "default") return;
    try {
      await Notification.requestPermission();
    } finally {
      listeners.forEach((cb) => cb());
    }
  };

  if (perm === "unsupported") {
    return <p className="text-sm text-muted">This browser does not support desktop notifications.</p>;
  }
  const state = perm === "granted" ? "On in this browser." : perm === "denied" ? "Blocked in this browser." : "Off.";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-sm">
          Desktop notifications: <span className={perm === "granted" ? "text-accent" : "text-muted"}>{state}</span>
        </p>
        <p className="mt-0.5 text-xs text-muted">
          A notification when an account goes offline, is blocked by Gmail, or drops under 5 drafts; clicking it opens that account&apos;s
          row. Per browser: enable it on each computer you watch from.
        </p>
      </div>
      {perm === "default" && (
        <button type="button" onClick={ask} className={btnPrimary}>
          Enable
        </button>
      )}
      {perm === "denied" && (
        <span className="text-xs text-muted">Allow notifications for this site in the browser&apos;s site settings, then reload.</span>
      )}
    </div>
  );
}
