"use client";

import { useSyncExternalStore } from "react";
import { ACCENTS, SCHEMES, parseTheme, readThemeRaw, saveTheme, subscribePrefs } from "@/lib/prefs";

const serverRaw = () => "";

// The Appearance card: colour scheme and accent, per browser. The choice is
// applied at once (data attributes on <html>) and again before the first
// paint on later loads, by the inline script in the layout.
export function ThemePicker() {
  const raw = useSyncExternalStore(subscribePrefs, readThemeRaw, serverRaw);
  const theme = parseTheme(raw);

  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1 text-xs text-muted">Scheme</div>
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Colour scheme">
          {SCHEMES.map((s) => {
            const on = theme.scheme === s.value;
            return (
              <button
                key={s.value}
                type="button"
                role="radio"
                aria-checked={on}
                title={s.hint}
                onClick={() => saveTheme({ ...theme, scheme: s.value })}
                className={
                  "rounded-md border px-2 py-1.5 text-sm transition-colors " +
                  (on ? "border-accent bg-accent/12 text-fg" : "border-line text-muted hover:bg-panel-2 hover:text-fg")
                }
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs text-muted">Accent</div>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => {
            const on = theme.accent === a.value;
            return (
              <button
                key={a.value}
                type="button"
                role="radio"
                aria-checked={on}
                title={a.label}
                aria-label={a.label}
                onClick={() => saveTheme({ ...theme, accent: a.value })}
                className={
                  "flex items-center gap-2 rounded-full border py-1 pl-1 pr-2.5 text-xs transition-colors " +
                  (on ? "border-accent bg-accent/12 text-fg" : "border-line text-muted hover:bg-panel-2 hover:text-fg")
                }
              >
                <span className="h-4 w-4 rounded-full ring-1 ring-black/20" style={{ background: a.swatch }} />
                {a.label}
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted">Saved in this browser only. The rows, pills and buttons take the accent; status colours stay as they are.</p>
    </div>
  );
}
