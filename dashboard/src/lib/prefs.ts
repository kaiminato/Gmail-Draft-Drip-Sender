// Per-browser preferences: which alerts to show, and how the dashboard looks.
// Both live in localStorage: desktop-notification permission is per browser
// anyway, and the theme has to be known before the first paint (the inline
// script in the layout reads the same key). Nothing here touches the server.
import type { AlertKind } from "./alerts";
import { AUTO_THEME_ID, THEME_IDS } from "./themes";

const CHANGE = "prefs-change";

/* ---------- alerts ---------- */

export type AlertPrefs = { enabled: boolean; mutedUntil: number; kinds: Record<AlertKind, boolean> };
export const ALERT_PREFS_KEY = "alert-prefs";
export const DEFAULT_ALERT_PREFS: AlertPrefs = {
  enabled: true,
  mutedUntil: 0,
  kinds: { offline: true, drafts: true, blocked: true },
};
export const ALERT_KINDS: { kind: AlertKind; label: string; hint: string }[] = [
  { kind: "offline", label: "Goes offline", hint: "No heartbeat for three minutes." },
  { kind: "drafts", label: "Low on drafts", hint: "Under 5 drafts left, or none." },
  { kind: "blocked", label: "Blocked by Gmail", hint: "Stopped by a block notice." },
];

export function parseAlertPrefs(raw: string | null): AlertPrefs {
  if (!raw) return DEFAULT_ALERT_PREFS;
  try {
    const p = JSON.parse(raw) as Partial<AlertPrefs>;
    return {
      enabled: p.enabled !== false,
      mutedUntil: Number(p.mutedUntil) || 0,
      kinds: { ...DEFAULT_ALERT_PREFS.kinds, ...(p.kinds || {}) },
    };
  } catch {
    return DEFAULT_ALERT_PREFS;
  }
}

export function readAlertPrefsRaw(): string {
  try {
    return localStorage.getItem(ALERT_PREFS_KEY) || "";
  } catch {
    return "";
  }
}

export const loadAlertPrefs = (): AlertPrefs => parseAlertPrefs(readAlertPrefsRaw());

export function saveAlertPrefs(p: AlertPrefs) {
  try {
    localStorage.setItem(ALERT_PREFS_KEY, JSON.stringify(p));
  } catch {
    // Storage blocked: the change lasts for this page only.
  }
  window.dispatchEvent(new Event(CHANGE));
}

export function alertAllowed(p: AlertPrefs, kind: AlertKind, now = Date.now()): boolean {
  return p.enabled && p.mutedUntil <= now && p.kinds[kind] !== false;
}

/* ---------- theme ---------- */

// One theme from the gallery (src/lib/themes.ts) by id, or "auto", which
// follows the operating system with the default dark and light looks.
export type Theme = { id: string };
export const THEME_KEY = "theme";
export const DEFAULT_THEME: Theme = { id: AUTO_THEME_ID };

export function parseTheme(raw: string | null): Theme {
  if (!raw) return DEFAULT_THEME;
  try {
    const t = JSON.parse(raw) as { id?: unknown; scheme?: unknown };
    if (typeof t.id === "string" && (t.id === AUTO_THEME_ID || THEME_IDS.has(t.id))) return { id: t.id };
    // The earlier scheme-and-accent form: keep the scheme, drop the accent.
    if (t.scheme === "dark") return { id: "observer-dark" };
    if (t.scheme === "light") return { id: "observer-light" };
    return DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function readThemeRaw(): string {
  try {
    return localStorage.getItem(THEME_KEY) || "";
  } catch {
    return "";
  }
}

// Puts the choice on <html> as data-theme, which the generated theme rules
// match; "auto" carries no attribute and gets the base stylesheet.
export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t.id === AUTO_THEME_ID) delete el.dataset.theme;
  else el.dataset.theme = t.id;
  delete el.dataset.scheme;
  delete el.dataset.accent;
}

export function saveTheme(t: Theme) {
  try {
    localStorage.setItem(THEME_KEY, JSON.stringify(t));
  } catch {
    // Storage blocked: the theme lasts for this page only.
  }
  applyTheme(t);
  window.dispatchEvent(new Event(CHANGE));
}

/* ---------- change notification for useSyncExternalStore ---------- */

export function subscribePrefs(cb: () => void) {
  window.addEventListener(CHANGE, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(CHANGE, cb);
    window.removeEventListener("storage", cb);
  };
}
