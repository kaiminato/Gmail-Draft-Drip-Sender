// Volume tiers: sends per day. Must match TIERS in extension/planner.js.
export const TIERS = {
  few: [10, 20],
  less: [20, 40],
  normal: [40, 60],
  many: [60, 80],
} as const;

export type Tier = keyof typeof TIERS;
export const TIER_ORDER: Tier[] = ["few", "less", "normal", "many"];

export function isTier(x: unknown): x is Tier {
  return typeof x === "string" && x in TIERS;
}

export const TIER_META: Record<Tier, { label: string; range: string; badge: string; bar: string }> = {
  few: {
    label: "Few",
    range: "10–20 / day",
    badge: "bg-slate-500/15 text-slate-700 ring-1 ring-inset ring-slate-500/30 dark:text-slate-300",
    bar: "border-l-slate-400",
  },
  less: {
    label: "Less",
    range: "20–40 / day",
    badge: "bg-sky-500/15 text-sky-700 ring-1 ring-inset ring-sky-500/30 dark:text-sky-300",
    bar: "border-l-sky-400",
  },
  normal: {
    label: "Normal",
    range: "40–60 / day",
    badge: "bg-emerald-500/15 text-emerald-700 ring-1 ring-inset ring-emerald-500/30 dark:text-emerald-300",
    bar: "border-l-emerald-400",
  },
  many: {
    label: "Many",
    range: "60–80 / day",
    badge: "bg-violet-500/15 text-violet-700 ring-1 ring-inset ring-violet-500/30 dark:text-violet-300",
    bar: "border-l-violet-400",
  },
};
