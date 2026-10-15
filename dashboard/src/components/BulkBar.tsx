"use client";

import { useEffect, useState } from "react";
import { TIER_META, TIER_ORDER } from "@/lib/tiers";

const tierBtn =
  "inline-flex h-7 items-center whitespace-nowrap rounded-md border border-line border-l-[3px] bg-panel px-2.5 text-xs font-medium text-fg transition-colors hover:bg-panel-2";

function boxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[name="ids"][form="bulk"]'));
}

// The Start/Stop buttons for the bulk form (`#bulk`, rendered by the page).
// With nothing ticked they sit inline and act on the whole list; once rows
// are ticked the bar floats at the bottom and acts on the selection only.
export function BulkBar({ scopeLabel }: { scopeLabel: string }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const update = () => setCount(boxes().filter((b) => b.checked).length);
    update();
    document.addEventListener("change", update);
    return () => document.removeEventListener("change", update);
  }, []);

  const clear = () => {
    boxes().forEach((b) => { b.checked = false; });
    const all = document.querySelector<HTMLInputElement>('input[data-select-all]');
    if (all) { all.checked = false; all.indeterminate = false; }
    setCount(0);
  };

  const floating = count > 0;
  const target = floating ? count + " selected" : scopeLabel;

  return (
    <div
      className={
        floating
          ? "fixed inset-x-0 bottom-4 z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-2 rounded-xl border border-accent/40 bg-panel px-3 py-2 shadow-2xl shadow-black/40"
          : "flex flex-wrap items-center gap-2"
      }
    >
      <span className={"text-xs " + (floating ? "font-medium text-fg" : "text-muted")}>
        {floating ? target : "Act on " + target + ":"}
      </span>
      {TIER_ORDER.map((t) => (
        <button key={t} form="bulk" name="action" value={"start:" + t} className={tierBtn + " " + TIER_META[t].bar} title={TIER_META[t].range}>
          Start {TIER_META[t].label.toLowerCase()}
        </button>
      ))}
      <button form="bulk" name="action" value="stop" className="inline-flex h-7 items-center rounded-md bg-danger/90 px-2.5 text-xs font-medium text-white hover:bg-danger">
        Stop
      </button>
      {floating && (
        <button type="button" onClick={clear} className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted hover:text-fg">
          Clear
        </button>
      )}
    </div>
  );
}

// Header checkbox: ticks or clears every row box.
export function SelectAll() {
  const [state, setState] = useState<"none" | "some" | "all">("none");

  useEffect(() => {
    const update = () => {
      const all = boxes();
      const n = all.filter((b) => b.checked).length;
      setState(n === 0 ? "none" : n === all.length ? "all" : "some");
    };
    update();
    document.addEventListener("change", update);
    return () => document.removeEventListener("change", update);
  }, []);

  return (
    <input
      type="checkbox"
      data-select-all
      aria-label="Select all"
      checked={state === "all"}
      ref={(el) => { if (el) el.indeterminate = state === "some"; }}
      onChange={(e) => {
        const on = e.currentTarget.checked;
        boxes().forEach((b) => { b.checked = on; });
        setState(on ? "all" : "none");
        document.dispatchEvent(new Event("change"));
      }}
    />
  );
}
