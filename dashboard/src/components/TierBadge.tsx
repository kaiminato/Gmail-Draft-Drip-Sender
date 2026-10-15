import { TIER_META, isTier } from "@/lib/tiers";

export function TierBadge({ tier, title }: { tier: string | null | undefined; title?: string }) {
  if (!isTier(tier)) return <span className="text-xs text-muted">—</span>;
  const m = TIER_META[tier];
  return (
    <span title={title ?? m.range} className={"inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide " + m.badge}>
      {m.label}
    </span>
  );
}
