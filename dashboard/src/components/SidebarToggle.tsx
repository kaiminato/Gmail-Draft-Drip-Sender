"use client";

import { useSyncExternalStore } from "react";

const KEY = "nav";

// The collapsed state lives on <html> as data-nav, which the stylesheet
// reads, and in localStorage; a tiny inline script in the layout restores it
// before the first paint so a collapsed sidebar never flashes open on load.
// The attribute is the source of truth, read here as an external store.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-nav"] });
  return () => observer.disconnect();
}
const isCollapsed = () => document.documentElement.dataset.nav === "collapsed";
const serverSnapshot = () => false;

export function SidebarToggle() {
  const collapsed = useSyncExternalStore(subscribe, isCollapsed, serverSnapshot);

  const toggle = () => {
    const next = collapsed ? "open" : "collapsed";
    document.documentElement.dataset.nav = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Private window or storage blocked: the choice lasts for this page only.
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!collapsed}
      className="mt-2 flex w-full items-center justify-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted transition-colors hover:bg-panel-2 hover:text-fg"
    >
      <svg viewBox="0 0 24 24" className={"h-4 w-4 transition-transform " + (collapsed ? "rotate-180" : "")} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 6l-6 6 6 6" />
      </svg>
      <span className="nav-label hidden md:inline">Collapse</span>
    </button>
  );
}

// Runs before the sidebar renders; see above.
export const RESTORE_NAV_SCRIPT =
  "try{if(localStorage.getItem('nav')==='collapsed')document.documentElement.dataset.nav='collapsed'}catch(e){}";
