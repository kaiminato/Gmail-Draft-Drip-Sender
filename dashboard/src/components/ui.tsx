import type { ReactNode } from "react";

// The handful of shared bits of chrome. Plain Tailwind over the theme tokens.

// Every button: a visible hover tint, a press-down on click, a focus ring for
// the keyboard, and no reaction at all while disabled.
const btnBase =
  "inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md px-2.5 text-xs font-medium transition duration-100 " +
  "active:translate-y-px active:brightness-90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent " +
  "disabled:pointer-events-none disabled:opacity-40";
export const btn = btnBase + " border border-line bg-panel text-fg hover:border-accent/50 hover:bg-accent/10 hover:text-accent";
export const btnPrimary = btnBase + " bg-accent text-accent-fg hover:brightness-110 hover:shadow-md hover:shadow-accent/30";
export const btnDanger = btnBase + " bg-danger/90 text-white hover:bg-danger hover:shadow-md hover:shadow-danger/30";
export const btnGhost = btnBase + " text-muted hover:bg-panel-2 hover:text-fg";
// The left edge carries the tier colour, so the hover tints the face only.
export const btnTier = btnBase + " border border-line border-l-[3px] bg-panel text-fg hover:bg-accent/10 hover:text-accent";

export const input =
  "h-7 rounded-md border border-line bg-panel-2 px-2 text-sm text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none";
export const select = input + " pr-6";

export function Card({ title, children, className = "", aside }: { title?: string; children: ReactNode; className?: string; aside?: ReactNode }) {
  return (
    <section className={"rounded-xl border border-line bg-panel p-4 " + className}>
      {(title || aside) && (
        <div className="mb-3 flex items-center justify-between gap-3">
          {title && <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{title}</h2>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "accent" | "warn" | "danger" | "info" }) {
  const toneClass = tone === "accent" ? "text-accent" : tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : tone === "info" ? "text-info" : "";
  return (
    <div className="rounded-xl border border-line bg-panel px-3.5 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted">{label}</div>
      <div className={"num mt-1 text-2xl font-semibold leading-none " + toneClass}>{value}</div>
      {sub && <div className="mt-1.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

export function PageHeader({ title, description, children }: { title: string; description?: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export const th = "sticky top-0 z-10 bg-panel px-2.5 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-muted";
export const td = "px-2.5 py-2 align-middle text-sm";
export const tableWrap = "overflow-x-auto rounded-xl border border-line bg-panel";
