"use client";

import { useState, useTransition } from "react";

type Option = { value: string; label: string };

// A <select> inside a server-action form that submits itself on change, so
// there is no Set button. Mount it with a `key` tied to the server value:
// React resets form fields after an action, and an uncontrolled select would
// otherwise keep showing the stale value after the data refreshes.
export function AutoSubmitSelect({
  name,
  value,
  options,
  placeholder,
  className = "",
  title,
}: {
  name: string;
  value: string;
  options: Option[];
  placeholder?: string;
  className?: string;
  title?: string;
}) {
  const [current, setCurrent] = useState(value);
  const [pending, startTransition] = useTransition();

  return (
    <select
      name={name}
      value={current}
      title={title}
      disabled={pending}
      className={className + (pending ? " opacity-60" : "")}
      onChange={(e) => {
        const v = e.currentTarget.value;
        const form = e.currentTarget.form;
        setCurrent(v);
        startTransition(() => {
          form?.requestSubmit();
        });
      }}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
