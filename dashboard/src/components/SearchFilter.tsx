"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

// The text filter on the accounts list. It lives in the address as ?q=, like
// the manager filter, so sorting, the auto-refresh and the bulk buttons all
// see the same rows; typing updates the address after a short pause rather
// than on every keystroke, and replaces the entry instead of stacking history.
export function SearchFilter({
  value,
  keep = "",
  className = "",
  placeholder = "Filter by email, manager, device…",
}: {
  value: string;
  // Query string to carry along: the manager filter and the sort.
  keep?: string;
  className?: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef(value);

  // A new address (back button, a cleared filter elsewhere) updates the box.
  useEffect(() => {
    if (value !== last.current) {
      last.current = value;
      setText(value);
    }
  }, [value]);

  const go = (q: string) => {
    if (q === last.current) return;
    last.current = q;
    const parts = [keep, q ? "q=" + encodeURIComponent(q) : ""].filter(Boolean).join("&");
    router.replace(parts ? "/?" + parts : "/");
  };

  const onChange = (q: string) => {
    setText(q);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => go(q.trim()), 250);
  };

  return (
    <div className={"relative " + className}>
      <svg viewBox="0 0 24 24" className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        type="search"
        value={text}
        onChange={(e) => onChange(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            if (timer.current) clearTimeout(timer.current);
            go(text.trim());
          } else if (e.key === "Escape") {
            onChange("");
          }
        }}
        placeholder={placeholder}
        aria-label="Filter accounts"
        className="h-7 w-full rounded-md border border-line bg-panel-2 pl-7 pr-7 text-sm text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none"
      />
      {text && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear filter"
          className="absolute right-1 top-1/2 -translate-y-1/2 rounded px-1 text-xs text-muted hover:text-fg"
        >
          ×
        </button>
      )}
    </div>
  );
}
