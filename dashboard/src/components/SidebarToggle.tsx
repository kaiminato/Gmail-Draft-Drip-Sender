"use client";

import { useEffect } from "react";

// The sidebar sits collapsed to its icons. A click anywhere on it opens it;
// a click anywhere else, or Escape, collapses it again. Nothing is kept
// between loads: it is collapsed at every first paint, set by the inline
// script below before the sidebar is drawn so it never flashes open. The
// state is the data-nav attribute on <html>, which the stylesheet reads.
export function SidebarBehavior() {
  useEffect(() => {
    const root = document.documentElement;
    const set = (open: boolean) => {
      root.dataset.nav = open ? "open" : "collapsed";
    };
    const onClick = (e: MouseEvent) => {
      const aside = document.querySelector("aside.sidebar");
      if (!aside) return;
      const inside = aside.contains(e.target as Node);
      if (inside) {
        if (root.dataset.nav !== "open") set(true);
      } else if (root.dataset.nav === "open") {
        set(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && root.dataset.nav === "open") set(false);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
  return null;
}

// Runs before anything renders: collapses the sidebar (see above) and puts
// the saved theme on <html> so the page never flashes the default colours.
// Same storage key and attributes as src/lib/prefs.ts.
export const RESTORE_NAV_SCRIPT =
  "document.documentElement.dataset.nav='collapsed';" +
  "try{var t=JSON.parse(localStorage.getItem('theme')||'{}'),d=document.documentElement.dataset;" +
  "if(t.scheme==='dark'||t.scheme==='light')d.scheme=t.scheme;" +
  "if(t.accent&&t.accent!=='emerald')d.accent=t.accent}catch(e){}";
