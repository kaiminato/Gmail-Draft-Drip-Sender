"use client";

import { useEffect } from "react";
import { parseTheme, readThemeRaw, subscribePrefs } from "@/lib/prefs";
import { OBSERVER_DARK, OBSERVER_LIGHT, THEMES, brandSvg } from "@/lib/themes";

// Keeps the tab icon in the current theme's colours. The static app/icon.svg
// is what the browser gets first; as soon as this runs, and again whenever
// the theme (or, on Auto, the system scheme) changes, every icon link is
// pointed at the brand mark drawn from that theme's tokens.
export function ThemeFavicon() {
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const id = parseTheme(readThemeRaw()).id;
      const t = THEMES.find((x) => x.id === id);
      const tokens = t ? t.tokens : mq.matches ? OBSERVER_LIGHT : OBSERVER_DARK;
      const href = "data:image/svg+xml," + encodeURIComponent(brandSvg(tokens, t?.radius ?? 1));
      let links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]'));
      if (!links.length) {
        const link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
        links = [link];
      }
      for (const link of links) {
        link.type = "image/svg+xml";
        link.href = href;
      }
    };
    apply();
    const off = subscribePrefs(apply);
    mq.addEventListener("change", apply);
    return () => {
      off();
      mq.removeEventListener("change", apply);
    };
  }, []);
  return null;
}
