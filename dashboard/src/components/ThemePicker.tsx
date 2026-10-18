"use client";

import { useSyncExternalStore } from "react";
import { parseTheme, readThemeRaw, saveTheme, subscribePrefs } from "@/lib/prefs";
import { AUTO_THEME_ID, OBSERVER_DARK, THEMES, type ThemeDef, type ThemeTokens } from "@/lib/themes";

const serverRaw = () => "";

const FONT_STACK: Record<NonNullable<ThemeDef["font"]>, string> = {
  sans: "inherit",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
  serif: "Georgia, 'Times New Roman', serif",
};

// A small mock of the dashboard drawn entirely from the theme's own tokens:
// sidebar, header, two account rows with their pills and status dots. What
// you see is what the real pages use, so the card is the preview.
function Preview({ tokens, font, radius = 1 }: { tokens: ThemeTokens; font?: ThemeDef["font"]; radius?: number }) {
  const r = (px: number) => px * radius + "px";
  const row = (dot: string, pill: string, pillFg: string, label: string, i: number) => (
    <div
      key={i}
      style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 7px", background: i % 2 ? tokens.panel2 : tokens.panel, borderTop: `1px solid ${tokens.line}` }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: dot, flex: "none" }} />
      <span style={{ flex: 1, height: 5, borderRadius: r(3), background: tokens.fg, opacity: 0.75 }} />
      <span style={{ fontSize: 7, lineHeight: "11px", padding: "0 5px", borderRadius: r(99), background: pill, color: pillFg }}>{label}</span>
      <span style={{ width: 18, height: 5, borderRadius: r(3), background: tokens.muted, opacity: 0.6 }} />
    </div>
  );
  return (
    <div
      aria-hidden="true"
      style={{
        display: "flex", height: 92, overflow: "hidden", borderRadius: r(8), border: `1px solid ${tokens.line}`,
        background: tokens.bg, color: tokens.fg, fontFamily: font ? FONT_STACK[font] : "inherit",
      }}
    >
      <div style={{ width: 22, background: tokens.panel, borderRight: `1px solid ${tokens.line}`, padding: 6, display: "flex", flexDirection: "column", gap: 5 }}>
        <span style={{ width: 10, height: 10, borderRadius: r(3), background: tokens.accent }} />
        <span style={{ width: 10, height: 4, borderRadius: r(2), background: tokens.muted, opacity: 0.6 }} />
        <span style={{ width: 10, height: 4, borderRadius: r(2), background: tokens.muted, opacity: 0.6 }} />
        <span style={{ width: 10, height: 4, borderRadius: r(2), background: tokens.muted, opacity: 0.6 }} />
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px" }}>
          <span style={{ width: 34, height: 6, borderRadius: r(3), background: tokens.fg }} />
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 7, lineHeight: "12px", padding: "0 6px", borderRadius: r(4), background: tokens.accent, color: tokens.accentFg, fontWeight: 600 }}>Start</span>
          <span style={{ fontSize: 7, lineHeight: "12px", padding: "0 6px", borderRadius: r(4), background: tokens.danger, color: "#fff", fontWeight: 600 }}>Stop</span>
        </div>
        <div style={{ margin: "0 8px", borderRadius: r(6), overflow: "hidden", border: `1px solid ${tokens.line}` }}>
          {row(tokens.accent, tokens.accent, tokens.accentFg, "Running", 0)}
          {row(tokens.warn, tokens.panel, tokens.warn, "Offline", 1)}
          {row(tokens.danger, tokens.panel, tokens.danger, "Blocked", 2)}
        </div>
      </div>
    </div>
  );
}

// The Appearance gallery: one card per theme, the current one marked. The
// choice is applied at once and remembered in this browser; the layout's
// inline script re-applies it before the first paint on later loads.
export function ThemePicker() {
  const raw = useSyncExternalStore(subscribePrefs, readThemeRaw, serverRaw);
  const current = parseTheme(raw).id;

  const card = (id: string, name: string, tagline: string, tokens: ThemeTokens, font?: ThemeDef["font"], radius?: number) => {
    const on = current === id;
    return (
      <button
        key={id}
        type="button"
        role="radio"
        aria-checked={on}
        onClick={() => saveTheme({ id })}
        className={
          "group flex flex-col gap-2 rounded-lg border p-2 text-left transition-colors " +
          (on ? "border-accent bg-accent/10 ring-1 ring-accent" : "border-line hover:border-accent/50 hover:bg-panel-2")
        }
      >
        <Preview tokens={tokens} font={font} radius={radius} />
        <div className="min-w-0 px-0.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{name}</span>
            {on && <span className="shrink-0 rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg">current</span>}
          </div>
          <div className="truncate text-xs text-muted" title={tagline}>{tagline}</div>
        </div>
      </button>
    );
  };

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" role="radiogroup" aria-label="Theme">
        {card(AUTO_THEME_ID, "Auto", "Observer Dark or Light, whichever your system uses.", OBSERVER_DARK)}
        {THEMES.map((t) => card(t.id, t.name, t.tagline, t.tokens, t.font, t.radius))}
      </div>
      <p className="text-xs text-muted">
        {THEMES.length + 1} looks. Saved in this browser only; each computer you watch from picks its own.
      </p>
    </div>
  );
}
