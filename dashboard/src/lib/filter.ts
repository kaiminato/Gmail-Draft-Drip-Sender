// The text filter on the accounts list, shared by the page (which rows to
// show) and the bulk action (which rows "all" means), so the two can never
// disagree. Every space-separated word must appear somewhere in the email,
// the manager's name, the device id or the version, case-insensitively.
export function filterWords(q: string | undefined | null): string[] {
  return (q || "").toLowerCase().split(/\s+/).filter(Boolean);
}

export function accountMatches(
  a: { email: string | null; deviceId: string; version: string | null },
  managerName: string | null | undefined,
  words: string[],
): boolean {
  if (!words.length) return true;
  const hay = [a.email, managerName, a.deviceId, a.version].filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}
