"use client";

import { useRouter } from "next/navigation";

const DIM = { color: "var(--muted)" };
const PLAIN = { color: "var(--fg)" };

// Changing the dropdown navigates straight to the filtered list. The two
// entries that are not managers are dimmed, both in the list and when chosen.
export function ManagerFilter({
  value,
  managers,
  className = "",
  keep = "",
  path = "/",
}: {
  value: string;
  managers: { id: string; name: string }[];
  className?: string;
  // Query string to carry along, such as the current sort.
  keep?: string;
  // The page the filter belongs to.
  path?: string;
}) {
  const router = useRouter();
  const special = value === "" || value === "none";
  return (
    <select
      value={value}
      className={className}
      style={special ? DIM : undefined}
      onChange={(e) => {
        const v = e.currentTarget.value;
        const q = [v ? "manager=" + encodeURIComponent(v) : "", keep].filter(Boolean).join("&");
        router.push(q ? path + "?" + q : path);
      }}
    >
      <option value="" style={DIM}>All managers</option>
      <option value="none" style={DIM}>Unassigned</option>
      {managers.map((m) => (
        <option key={m.id} value={m.id} style={PLAIN}>
          {m.name}
        </option>
      ))}
    </select>
  );
}
