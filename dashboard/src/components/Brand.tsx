// The mark used in the sidebar and on the login page: a tile in the theme's
// accent, an envelope in its panel colour, and a dot in its warning colour,
// all read from the CSS variables, so it recolours with whatever theme is
// on. The tab icon is the same drawing, regenerated from the theme's tokens
// by ThemeFavicon (app/icon.svg is only the default before any script runs).
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="16" fill="var(--accent)" />
      <rect x="12" y="19" width="40" height="28" rx="6" fill="var(--panel)" />
      <path d="M15 24 L32 37 L49 24" fill="none" stroke="var(--accent)" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="51" cy="16" r="7.5" fill="var(--panel)" />
      <circle cx="51" cy="16" r="4" fill="var(--warn)" />
    </svg>
  );
}

export const APP_NAME = "Email Watchdog";
