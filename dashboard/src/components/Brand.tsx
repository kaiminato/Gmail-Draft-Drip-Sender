// The mark used in the sidebar and on the login page. Same drawing as
// app/icon.svg so the tab icon and the header match: a green tile, a white
// envelope, and an amber dot for "observer".
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="brand-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6ee7b7" />
          <stop offset="1" stopColor="#10b981" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="url(#brand-g)" />
      <rect x="12" y="19" width="40" height="28" rx="6" fill="#ffffff" />
      <path d="M15 24 L32 37 L49 24" fill="none" stroke="#10b981" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="51" cy="16" r="7.5" fill="#ffffff" />
      <circle cx="51" cy="16" r="4" fill="#f59e0b" />
    </svg>
  );
}

export const APP_NAME = "Kai Email Observer";
