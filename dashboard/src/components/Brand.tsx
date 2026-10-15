// The mark used in the sidebar and on the login page. Same drawing as
// app/icon.svg so the tab icon and the header match.
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="14" fill="#0f1620" />
      <rect x="2" y="2" width="60" height="60" rx="14" fill="none" stroke="#1f2a37" strokeWidth="2" />
      <rect x="13" y="19" width="38" height="27" rx="5" fill="none" stroke="#e5e7eb" strokeWidth="3.5" />
      <path d="M15 22 L32 35 L49 22" fill="none" stroke="#e5e7eb" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="50" cy="16" r="7" fill="#34d399" />
      <circle cx="50" cy="16" r="3" fill="#052e1c" />
    </svg>
  );
}

export const APP_NAME = "Kai Email Observer";
