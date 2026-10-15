"use client";

import { useEffect, useState } from "react";
import { TIER_META, TIER_ORDER } from "@/lib/tiers";
import { btnDanger, btnGhost, btnTier } from "@/components/ui";

function boxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[name="ids"][form="bulk"]'));
}

// Start/Stop for the bulk form (`#bulk`, rendered by the page). The bar sits
// inline under the stats, "Select all" on the left and the buttons on the
// right. With nothing ticked the buttons act on the whole list; with rows
// ticked, on the selection. It floats at the bottom only for a hand-picked
// part of the list, where the rows may be far from the bar; after Select all
// it stays where it is.
export function BulkBar({ scopeLabel }: { scopeLabel: string }) {
  const [sel, setSel] = useState({ count: 0, total: 0 });

  useEffect(() => {
    const update = () => {
      const all = boxes();
      setSel({ count: all.filter((b) => b.checked).length, total: all.length });
    };
    update();
    document.addEventListener("change", update);
    return () => document.removeEventListener("change", update);
  }, []);

  const clear = () => {
    boxes().forEach((b) => { b.checked = false; });
    // Every SelectAll box follows the rows through this event.
    document.dispatchEvent(new Event("change"));
  };

  const { count, total } = sel;
  const floating = count > 0 && count < total;

  return (
    <div
      className={
        floating
          ? "fixed inset-x-0 bottom-4 z-30 mx-auto flex w-fit max-w-[calc(100vw-2rem)] flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-panel px-3 py-2 shadow-2xl shadow-black/40"
          : "flex flex-wrap items-center justify-between gap-3"
      }
    >
      <SelectAll label="Select all" />
      <div className="flex flex-wrap items-center gap-2">
        <span className={"text-xs " + (floating ? "font-medium text-fg" : "text-muted")}>
          {count > 0 ? count + " selected" + (floating ? "" : ":") : "Act on " + scopeLabel + ":"}
        </span>
        {TIER_ORDER.map((t) => (
          <button key={t} form="bulk" name="action" value={"start:" + t} className={btnTier + " " + TIER_META[t].bar} title={TIER_META[t].range}>
            Start {TIER_META[t].label.toLowerCase()}
          </button>
        ))}
        <button form="bulk" name="action" value="stop" className={btnDanger}>
          Stop
        </button>
        {count > 0 && (
          <button type="button" onClick={clear} className={btnGhost}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

// Ticks or clears every row box. One sits in the table header (unlabelled),
// one in the bulk bar (labelled); each follows the rows, so they always agree.
export function SelectAll({ label }: { label?: string }) {
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

  const box = (
    <input
      type="checkbox"
      data-select-all
      aria-label={label ? undefined : "Select all"}
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
  if (!label) return box;
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted hover:text-fg">
      {box}
      {label}
    </label>
  );
}
