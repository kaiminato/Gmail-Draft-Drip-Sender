"use client";

import { useEffect, useRef, useState } from "react";
import { btn, btnPrimary } from "@/components/ui";

function tickedIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>('input[name="ids"][form="del"]'))
    .filter((b) => b.checked)
    .map((b) => b.value);
}

// The CSV button on the Sent page: a dropdown with one checkbox per column
// and a Download button. The download is a plain form post to the export
// route, so the browser saves the file and the page stays where it is. It
// covers every row matching the page's filter, across all pages, or only
// the ticked rows when there are any.
export function CsvExport({
  manager,
  q,
  matching,
  fields,
}: {
  manager: string;
  q: string;
  matching: number;
  fields: { key: string; label: string; checked: boolean }[];
}) {
  const [ticked, setTicked] = useState(0);
  const details = useRef<HTMLDetailsElement>(null);
  const idsBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => setTicked(tickedIds().length);
    update();
    document.addEventListener("change", update);
    return () => document.removeEventListener("change", update);
  }, []);

  return (
    <details ref={details} className="relative">
      <summary className={btn + " cursor-pointer list-none"} title="Download the log as a CSV file">
        CSV ▾
      </summary>
      <form
        method="post"
        action="/api/sent/export"
        className="absolute right-0 z-20 mt-1 w-64 space-y-2 rounded-lg border border-line bg-panel p-3 shadow-xl shadow-black/40"
        onSubmit={() => {
          // The ticked rows travel as hidden inputs, added at the last moment
          // so they reflect the selection as it is now.
          const box = idsBox.current;
          if (box) {
            box.innerHTML = "";
            for (const id of tickedIds()) {
              const input = document.createElement("input");
              input.type = "hidden";
              input.name = "ids";
              input.value = id;
              box.appendChild(input);
            }
          }
          setTimeout(() => { if (details.current) details.current.open = false; }, 300);
        }}
      >
        <input type="hidden" name="manager" value={manager} />
        <input type="hidden" name="q" value={q} />
        <div ref={idsBox} />
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Columns</div>
        <div className="grid grid-cols-1 gap-1">
          {fields.map((f) => (
            <label key={f.key} className="inline-flex cursor-pointer items-center gap-2 text-xs">
              <input type="checkbox" name="fields" value={f.key} defaultChecked={f.checked} />
              {f.label}
            </label>
          ))}
        </div>
        <div className="border-t border-line pt-2 text-xs text-muted">
          {ticked > 0 ? ticked + " ticked row" + (ticked === 1 ? "" : "s") : "All " + matching + " matching row" + (matching === 1 ? "" : "s") + ", every page"}
        </div>
        <button className={btnPrimary + " w-full justify-center"}>Download CSV</button>
      </form>
    </details>
  );
}
