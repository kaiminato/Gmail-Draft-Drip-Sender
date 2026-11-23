"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { diffSnapshots, type AccountSnap, type Alert } from "@/lib/alerts";
import { alertAllowed, loadAlertPrefs } from "@/lib/prefs";

// One beat's worth. Unlike the page's own auto-refresh this keeps running in
// a hidden tab - reaching you with the dashboard in the background is what it
// is for - so it is the one request a parked tab makes, and it backs off to
// the idle beat when nothing in the fleet is sending.
const POLL_MS = 60000;
const IDLE_POLL_MS = 300000;
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

// Polls the account summary once a minute, compares it with the last
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      // A sending fleet is worth following every minute; a paused one reports
      // every five, so polling it that fast only asks the same question again.
      let delay = POLL_MS;
      try {
        const r = await fetch("/api/accounts/summary", { cache: "no-store" });
        if (!r.ok) return;
        const data = (await r.json()) as { accounts: AccountSnap[] };
        if (stopped) return;
        if (!data.accounts.some((a) => a.status === "running")) delay = IDLE_POLL_MS;
        // The baseline moves on whether or not anything is shown, so a
        // muted hour does not replay later. The switches on the Settings
        // page decide what is shown, toasts and desktop pop-ups alike.
        const prefs = loadAlertPrefs();
        const alerts = diffSnapshots(prev, data.accounts).filter((a) => alertAllowed(prefs, a.kind));
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
        // Offline or signed out: try again at the normal rate.
      } finally {
        if (!stopped) timer = setTimeout(tick, delay);
      }
    };
    tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
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
