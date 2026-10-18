"use client";

import { useEffect } from "react";

const HOLD_MS = 20000;

// Scrolls the highlighted account row into view when the page opens from a
// notification (`?highlight=` or `?device=`), then drops those parameters
// from the address so the mark goes away on the next auto-refresh and a
// reload does not jump again.
export function HighlightRow({ id }: { id: string }) {
  useEffect(() => {
    const el = document.getElementById("acct-" + id);
    if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    const t = setTimeout(() => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("highlight");
        url.searchParams.delete("device");
        window.history.replaceState(null, "", url.pathname + (url.search || "") + url.hash);
      } catch {
        // Nothing to clean up if the URL cannot be rewritten.
      }
    }, HOLD_MS);
    return () => clearTimeout(t);
  }, [id]);
  return null;
}
