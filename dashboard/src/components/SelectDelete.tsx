"use client";

import { useEffect, useState } from "react";
import { btnDanger, btnGhost } from "@/components/ui";

function boxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[name="ids"][form="del"]'));
}

// Selection bar for a log table: a select-all for the rows on the page, the
// count, and a Delete button that submits the `#del` form (rendered by the
// page) after a confirmation. Row checkboxes point at that form with
// form="del", so the page's other forms stay valid.
export function SelectDelete({ shown, total, what = "entries" }: { shown: number; total: number; what?: string }) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const update = () => setCount(boxes().filter((b) => b.checked).length);
    update();
    document.addEventListener("change", update);
    return () => document.removeEventListener("change", update);
  }, []);

  const setAll = (on: boolean) => {
    boxes().forEach((b) => { b.checked = on; });
    document.dispatchEvent(new Event("change"));
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <label className="inline-flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted hover:text-fg">
        <input
          type="checkbox"
          checked={shown > 0 && count === shown}
          ref={(el) => { if (el) el.indeterminate = count > 0 && count < shown; }}
          onChange={(e) => setAll(e.currentTarget.checked)}
          aria-label="Select all on this page"
          disabled={shown === 0}
        />
        Select all on this page
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">{count > 0 ? count + " selected" : shown + " of " + total + " shown"}</span>
        <button
          form="del"
          className={btnDanger}
          disabled={count === 0}
          onClick={(e) => {
            const ok = confirm(
              "Delete " + count + " " + (count === 1 ? what.replace(/ies$/, "y").replace(/s$/, "") : what) +
                " from this log? The statistics are not affected.",
            );
            if (!ok) e.preventDefault();
            else setTimeout(() => setCount(0), 0);
          }}
        >
          Delete selected
        </button>
        {count > 0 && (
          <button type="button" onClick={() => setAll(false)} className={btnGhost}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
