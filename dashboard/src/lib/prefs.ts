// Per-browser preferences: which alerts to show, and how the dashboard looks.
// Both live in localStorage: desktop-notification permission is per browser
// anyway, and the theme has to be known before the first paint (the inline
// script in the layout reads the same key). Nothing here touches the server.
import type { AlertKind } from "./alerts";

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

export type Scheme = "system" | "dark" | "light";
export type Accent = "emerald" | "sky" | "violet" | "amber" | "rose";
export type Theme = { scheme: Scheme; accent: Accent };
export const THEME_KEY = "theme";
export const DEFAULT_THEME: Theme = { scheme: "system", accent: "emerald" };

export const SCHEMES: { value: Scheme; label: string; hint: string }[] = [
  { value: "system", label: "System", hint: "Follows the operating system." },
  { value: "dark", label: "Dark", hint: "Always dark." },
  { value: "light", label: "Light", hint: "Always light." },
];
// The swatch is the dark-scheme accent; the stylesheet has the light one.
export const ACCENTS: { value: Accent; label: string; swatch: string }[] = [
  { value: "emerald", label: "Emerald", swatch: "#34d399" },
  { value: "sky", label: "Sky", swatch: "#60a5fa" },
  { value: "violet", label: "Violet", swatch: "#a78bfa" },
  { value: "amber", label: "Amber", swatch: "#fbbf24" },
  { value: "rose", label: "Rose", swatch: "#fb7185" },
];

const isScheme = (v: unknown): v is Scheme => SCHEMES.some((s) => s.value === v);
const isAccent = (v: unknown): v is Accent => ACCENTS.some((a) => a.value === v);

export function parseTheme(raw: string | null): Theme {
  if (!raw) return DEFAULT_THEME;
  try {
    const t = JSON.parse(raw) as Partial<Theme>;
    return { scheme: isScheme(t.scheme) ? t.scheme : "system", accent: isAccent(t.accent) ? t.accent : "emerald" };
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

// Puts the choice on <html> as data-scheme / data-accent, which the
// stylesheet reads; the defaults carry no attribute at all.
export function applyTheme(t: Theme) {
  const el = document.documentElement;
  if (t.scheme === "system") delete el.dataset.scheme;
  else el.dataset.scheme = t.scheme;
  if (t.accent === "emerald") delete el.dataset.accent;
  else el.dataset.accent = t.accent;
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
