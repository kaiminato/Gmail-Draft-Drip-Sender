"use client";

import { useSyncExternalStore } from "react";
import { btn, btnPrimary } from "@/components/ui";
import { ALERT_KINDS, parseAlertPrefs, readAlertPrefsRaw, saveAlertPrefs, subscribePrefs, type AlertPrefs } from "@/lib/prefs";

/* ---------- browser permission ---------- */

type Perm = "unsupported" | "default" | "granted" | "denied";
const permListeners = new Set<() => void>();
const subscribePerm = (cb: () => void) => {
  permListeners.add(cb);
  return () => {
    permListeners.delete(cb);
  };
};
const readPerm = (): Perm => (typeof Notification === "undefined" ? "unsupported" : Notification.permission);
const serverPerm = (): Perm => "default";

const MUTES: { label: string; ms: number }[] = [
  { label: "1 hour", ms: 3600e3 },
  { label: "8 hours", ms: 8 * 3600e3 },
  { label: "1 day", ms: 24 * 3600e3 },
  { label: "3 days", ms: 3 * 24 * 3600e3 },
  { label: "1 week", ms: 7 * 24 * 3600e3 },
];

const serverRaw = () => "";

// Clock reads live outside the component: render stays pure for the React
// compiler's lint, and the handlers read the time when they run.
const isMuted = (p: AlertPrefs) => p.mutedUntil > Date.now();
const muteFor = (p: AlertPrefs, ms: number) => saveAlertPrefs({ ...p, mutedUntil: Date.now() + ms });

function fmtUntil(ms: number) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

// The Settings card: whether alerts show at all, a mute for a while, which
// kinds, and the browser's permission for desktop notifications. Everything
// is per browser, like the permission itself, so each computer the dashboard
// is watched from is set up once. The toasts in the corner follow the same
// switches, so "off" or "muted" means quiet, not just no desktop pop-up.
export function NotificationPrefs() {
  const perm = useSyncExternalStore(subscribePerm, readPerm, serverPerm);
  const raw = useSyncExternalStore(subscribePrefs, readAlertPrefsRaw, serverRaw);
  const prefs = parseAlertPrefs(raw);
  const muted = isMuted(prefs);

  const ask = async () => {
    if (perm !== "default") return;
    try {
      await Notification.requestPermission();
    } finally {
      permListeners.forEach((cb) => cb());
    }
  };

  const toggleAll = () => saveAlertPrefs({ ...prefs, enabled: !prefs.enabled });
  const unmute = () => saveAlertPrefs({ ...prefs, mutedUntil: 0 });
  const toggleKind = (kind: keyof typeof prefs.kinds) =>
    saveAlertPrefs({ ...prefs, kinds: { ...prefs.kinds, [kind]: !prefs.kinds[kind] } });

  const state = !prefs.enabled ? "Off" : muted ? "Muted until " + fmtUntil(prefs.mutedUntil) : "On";
  const tone = !prefs.enabled ? "text-muted" : muted ? "text-warn" : "text-accent";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={prefs.enabled} onChange={toggleAll} />
          <span>
            Alerts: <span className={tone}>{state}</span>
          </span>
        </label>
        {muted ? (
          <button type="button" onClick={unmute} className={btn}>
            Unmute
          </button>
        ) : null}
      </div>

      <div>
        <div className="mb-1 text-xs text-muted">Mute for</div>
        <div className="flex flex-wrap gap-1.5">
          {MUTES.map((m) => (
            <button key={m.ms} type="button" onClick={() => muteFor(prefs, m.ms)} disabled={!prefs.enabled} className={btn + " disabled:opacity-50"}>
              {m.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted">Tell me when an account</div>
        <div className="grid gap-1.5 sm:grid-cols-3">
          {ALERT_KINDS.map((k) => (
            <label key={k.kind} className="flex cursor-pointer items-start gap-2 rounded-md border border-line px-2.5 py-2 text-sm hover:bg-panel-2" title={k.hint}>
              <input type="checkbox" className="mt-0.5" checked={prefs.kinds[k.kind] !== false} onChange={() => toggleKind(k.kind)} disabled={!prefs.enabled} />
              <span>
                <span className="block">{k.label}</span>
                <span className="block text-xs text-muted">{k.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <div className="min-w-0">
          <p className="text-sm">
            Desktop notifications:{" "}
            <span className={perm === "granted" ? "text-accent" : "text-muted"}>
              {perm === "unsupported"
                ? "not supported by this browser."
                : perm === "granted"
                  ? "allowed in this browser."
                  : perm === "denied"
                    ? "blocked in this browser."
                    : "not allowed yet."}
            </span>
          </p>
          <p className="mt-0.5 text-xs text-muted">
            Pop-ups outside the tab, following the switches above; clicking one opens that account&apos;s row. Per browser: allow it on each
            computer you watch from.
          </p>
        </div>
        {perm === "default" && (
          <button type="button" onClick={ask} className={btnPrimary}>
            Allow
          </button>
        )}
        {perm === "denied" && <span className="text-xs text-muted">Allow notifications for this site in the browser&apos;s site settings, then reload.</span>}
      </div>
    </div>
  );
}
