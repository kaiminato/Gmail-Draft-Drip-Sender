"use client";

import { useRouter } from "next/navigation";

// Changing the dropdown navigates straight to the filtered list.
export function ManagerFilter({
  value,
  managers,
  className = "",
}: {
  value: string;
  managers: { id: string; name: string }[];
  className?: string;
}) {
  const router = useRouter();
  return (
    <select
      value={value}
      className={className}
      onChange={(e) => {
        const v = e.currentTarget.value;
        router.push(v ? "/?manager=" + encodeURIComponent(v) : "/");
      }}
    >
      <option value="">All managers</option>
      <option value="none">Unassigned</option>
      {managers.map((m) => (
        <option key={m.id} value={m.id}>
          {m.name}
        </option>
      ))}
    </select>
  );
}
