// The theme gallery. Every theme is a complete look: the colour tokens the
// stylesheet reads, the colour-scheme hint for form controls and scrollbars,
// and, where it suits the character, a typeface and a corner-radius scale.
// The CSS for all of them comes out of themeCss() once and is inlined by the
// layout, so a saved choice applies before the first paint; the gallery on
// the Settings page draws its previews from the same data. Status colours
// (warn, danger, info) are part of each theme too, chosen to stay readable
// on its background.

export type ThemeTokens = {
  bg: string;
  panel: string;
  panel2: string;
  line: string;
  fg: string;
  muted: string;
  accent: string;
  accentFg: string;
  warn: string;
  danger: string;
  info: string;
};

export type ThemeDef = {
  id: string;
  name: string;
  tagline: string;
  scheme: "dark" | "light";
  font?: "sans" | "mono" | "serif";
  radius?: number; // multiplier on the corner radii; 0 is square
  tokens: ThemeTokens;
};

export const AUTO_THEME_ID = "auto";

export const OBSERVER_DARK: ThemeTokens = {
  bg: "#0b0f14", panel: "#111823", panel2: "#0f1620", line: "#1f2a37", fg: "#e5e7eb", muted: "#8b95a5",
  accent: "#34d399", accentFg: "#052e1c", warn: "#fbbf24", danger: "#f87171", info: "#60a5fa",
};
export const OBSERVER_LIGHT: ThemeTokens = {
  bg: "#f4f6f8", panel: "#ffffff", panel2: "#f9fafb", line: "#e3e7ec", fg: "#111827", muted: "#6b7280",
  accent: "#059669", accentFg: "#ffffff", warn: "#d97706", danger: "#dc2626", info: "#2563eb",
};

export const THEMES: ThemeDef[] = [
  { id: "observer-dark", name: "Observer Dark", tagline: "The default. Graphite and emerald.", scheme: "dark", tokens: OBSERVER_DARK },
  { id: "observer-light", name: "Observer Light", tagline: "The default, in daylight.", scheme: "light", tokens: OBSERVER_LIGHT },
  {
    id: "midnight", name: "Midnight", tagline: "Deep navy, cool blue light.", scheme: "dark",
    tokens: { bg: "#0a0f1f", panel: "#111a33", panel2: "#0d1529", line: "#22305a", fg: "#e6ecff", muted: "#8a97c2", accent: "#7aa2ff", accentFg: "#0a1130", warn: "#ffcf5c", danger: "#ff6b81", info: "#5ad1ff" },
  },
  {
    id: "ocean", name: "Ocean", tagline: "Dark water, cyan surf.", scheme: "dark",
    tokens: { bg: "#06141f", panel: "#0b1f2e", panel2: "#081a28", line: "#17344d", fg: "#dceefb", muted: "#7fa3bd", accent: "#22d3ee", accentFg: "#042a33", warn: "#fbbf24", danger: "#fb7185", info: "#60a5fa" },
  },
  {
    id: "forest", name: "Forest", tagline: "Moss, pine and a little sunlight.", scheme: "dark",
    tokens: { bg: "#0f1a14", panel: "#15231b", panel2: "#121e17", line: "#28402f", fg: "#e3efe6", muted: "#8aa894", accent: "#6ee7a0", accentFg: "#06281a", warn: "#f4c95d", danger: "#f87171", info: "#7dd3fc" },
  },
  {
    id: "sunset", name: "Sunset", tagline: "Plum dusk with a coral glow.", scheme: "dark",
    tokens: { bg: "#1b1020", panel: "#26162e", panel2: "#211328", line: "#41284c", fg: "#fbe9f0", muted: "#b48ca6", accent: "#ff7a59", accentFg: "#2a0e08", warn: "#ffd166", danger: "#ff4d6d", info: "#8ecae6" },
  },
  {
    id: "ember", name: "Ember", tagline: "Charcoal and a warm orange coal.", scheme: "dark",
    tokens: { bg: "#141210", panel: "#1d1a16", panel2: "#191613", line: "#332d26", fg: "#f1e9e0", muted: "#a0948a", accent: "#f59e0b", accentFg: "#2a1700", warn: "#fde68a", danger: "#f87171", info: "#7dd3fc" },
  },
  {
    id: "terminal", name: "Terminal", tagline: "Black glass, green phosphor, monospace, square.", scheme: "dark", font: "mono", radius: 0,
    tokens: { bg: "#000000", panel: "#0a0f0a", panel2: "#061006", line: "#1d3f1d", fg: "#b7f7b7", muted: "#5f9e5f", accent: "#39ff14", accentFg: "#00240a", warn: "#ffd93d", danger: "#ff5555", info: "#7df9ff" },
  },
  {
    id: "amber-crt", name: "Amber CRT", tagline: "The other old monitor. Monospace, square.", scheme: "dark", font: "mono", radius: 0,
    tokens: { bg: "#0d0a04", panel: "#171106", panel2: "#120d05", line: "#3a2b0c", fg: "#ffd27a", muted: "#a8872f", accent: "#ffb000", accentFg: "#231700", warn: "#ffe08a", danger: "#ff6b57", info: "#ffd27a" },
  },
  {
    id: "nord", name: "Nord", tagline: "Arctic blue-grey, frost accent.", scheme: "dark",
    tokens: { bg: "#2e3440", panel: "#3b4252", panel2: "#353c4a", line: "#4c566a", fg: "#eceff4", muted: "#a3adc2", accent: "#88c0d0", accentFg: "#1f2733", warn: "#ebcb8b", danger: "#bf616a", info: "#81a1c1" },
  },
  {
    id: "dracula", name: "Dracula", tagline: "Night purple, candy accents.", scheme: "dark",
    tokens: { bg: "#282a36", panel: "#2f3241", panel2: "#2b2e3b", line: "#44475a", fg: "#f8f8f2", muted: "#9ca0b8", accent: "#bd93f9", accentFg: "#1e1b2e", warn: "#f1fa8c", danger: "#ff5555", info: "#8be9fd" },
  },
  {
    id: "gruvbox", name: "Gruvbox", tagline: "Warm retro browns and olive.", scheme: "dark",
    tokens: { bg: "#282828", panel: "#32302f", panel2: "#2d2b2a", line: "#504945", fg: "#ebdbb2", muted: "#a89984", accent: "#b8bb26", accentFg: "#1d2021", warn: "#fabd2f", danger: "#fb4934", info: "#83a598" },
  },
  {
    id: "catppuccin", name: "Catppuccin", tagline: "Soft pastels on mocha, rounder corners.", scheme: "dark", radius: 1.4,
    tokens: { bg: "#1e1e2e", panel: "#24243a", panel2: "#202032", line: "#383856", fg: "#cdd6f4", muted: "#9399b2", accent: "#f5c2e7", accentFg: "#2a1a28", warn: "#f9e2af", danger: "#f38ba8", info: "#89b4fa" },
  },
  {
    id: "rose-pine", name: "Rosé Pine", tagline: "Muted rose, gold and foam.", scheme: "dark",
    tokens: { bg: "#191724", panel: "#1f1d2e", panel2: "#1c1a2a", line: "#352f4b", fg: "#e0def4", muted: "#908caa", accent: "#ebbcba", accentFg: "#2b1b1a", warn: "#f6c177", danger: "#eb6f92", info: "#9ccfd8" },
  },
  {
    id: "monokai", name: "Monokai", tagline: "Editor classic: lime, pink, sky.", scheme: "dark",
    tokens: { bg: "#272822", panel: "#2e2f28", panel2: "#2a2b24", line: "#49483e", fg: "#f8f8f2", muted: "#a6a68f", accent: "#a6e22e", accentFg: "#1b1c15", warn: "#e6db74", danger: "#f92672", info: "#66d9ef" },
  },
  {
    id: "solarized-dark", name: "Solarized Dark", tagline: "Teal-blue depths, measured contrast.", scheme: "dark",
    tokens: { bg: "#002b36", panel: "#073642", panel2: "#04313b", line: "#114d5c", fg: "#eee8d5", muted: "#93a1a1", accent: "#2aa198", accentFg: "#002b36", warn: "#b58900", danger: "#dc322f", info: "#268bd2" },
  },
  {
    id: "solarized-light", name: "Solarized Light", tagline: "Warm paper, the same palette.", scheme: "light",
    tokens: { bg: "#fdf6e3", panel: "#fffdf5", panel2: "#f5efdc", line: "#e6dfc6", fg: "#073642", muted: "#657b83", accent: "#2aa198", accentFg: "#fdf6e3", warn: "#b58900", danger: "#dc322f", info: "#268bd2" },
  },
  {
    id: "paper", name: "Paper", tagline: "Cream stock, ink and a serif face.", scheme: "light", font: "serif",
    tokens: { bg: "#f7f3ea", panel: "#fffdf8", panel2: "#f3eee3", line: "#e3dccb", fg: "#2b2721", muted: "#7a7265", accent: "#8a5a2b", accentFg: "#ffffff", warn: "#b7791f", danger: "#c0392b", info: "#2b6cb0" },
  },
  {
    id: "daylight", name: "Daylight", tagline: "Cool grey-blue, crisp and bright.", scheme: "light",
    tokens: { bg: "#eef2f6", panel: "#ffffff", panel2: "#f6f8fb", line: "#d9e0e8", fg: "#0f172a", muted: "#5b6b7f", accent: "#2563eb", accentFg: "#ffffff", warn: "#d97706", danger: "#dc2626", info: "#0284c7" },
  },
  {
    id: "sakura", name: "Sakura", tagline: "Blossom pink, soft and rounded.", scheme: "light", radius: 1.5,
    tokens: { bg: "#fff5f7", panel: "#ffffff", panel2: "#fdeef2", line: "#f3d6de", fg: "#3b2a31", muted: "#8a6f78", accent: "#e0528a", accentFg: "#ffffff", warn: "#d98b00", danger: "#d63c3c", info: "#3b82f6" },
  },
  {
    id: "mint", name: "Mint", tagline: "Pale green, fresh and airy.", scheme: "light", radius: 1.3,
    tokens: { bg: "#f0faf5", panel: "#ffffff", panel2: "#e8f6ef", line: "#cfe9db", fg: "#13332a", muted: "#5f7f72", accent: "#0f9f6e", accentFg: "#ffffff", warn: "#d97706", danger: "#dc2626", info: "#0e7490" },
  },
  {
    id: "high-contrast", name: "High Contrast", tagline: "Black, white, yellow. Square. For tired eyes.", scheme: "dark", radius: 0,
    tokens: { bg: "#000000", panel: "#000000", panel2: "#0a0a0a", line: "#ffffff", fg: "#ffffff", muted: "#d4d4d4", accent: "#ffff00", accentFg: "#000000", warn: "#ffb000", danger: "#ff3b3b", info: "#00c2ff" },
  },
];

export const THEME_IDS = new Set(THEMES.map((t) => t.id));

// The brand mark as a standalone SVG in a theme's own colours: the tab icon
// (ThemeFavicon) is built from this, and it mirrors BrandMark, which draws
// the same shapes from the CSS variables. Square themes get a square tile.
export function brandSvg(k: ThemeTokens, radius = 1): string {
  const r = (n: number) => (n * radius).toFixed(1);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
    `<rect x="2" y="2" width="60" height="60" rx="${r(16)}" fill="${k.accent}"/>` +
    `<rect x="12" y="19" width="40" height="28" rx="${r(6)}" fill="${k.panel}"/>` +
    `<path d="M15 24 L32 37 L49 24" fill="none" stroke="${k.accent}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>` +
    `<circle cx="51" cy="16" r="7.5" fill="${k.panel}"/>` +
    `<circle cx="51" cy="16" r="4" fill="${k.warn}"/>` +
    `</svg>`
  );
}

const FONT_VAR: Record<NonNullable<ThemeDef["font"]>, string> = {
  sans: "var(--font-geist-sans)",
  mono: "var(--font-geist-mono)",
  serif: "var(--font-lora)",
};

// One rule per theme; the base tokens in globals.css stay the fallback for
// "auto", which follows the operating system.
export function themeCss(): string {
  return THEMES.map((t) => {
    const k = t.tokens;
    const parts = [
      `--bg:${k.bg}`, `--panel:${k.panel}`, `--panel-2:${k.panel2}`, `--line:${k.line}`, `--fg:${k.fg}`, `--muted:${k.muted}`,
      `--accent:${k.accent}`, `--accent-fg:${k.accentFg}`, `--warn:${k.warn}`, `--danger:${k.danger}`, `--info:${k.info}`,
      `color-scheme:${t.scheme}`,
    ];
    if (t.font) parts.push(`--font-ui:${FONT_VAR[t.font]}`);
    if (t.radius !== undefined) parts.push(`--radius-scale:${t.radius}`);
    return `:root[data-theme="${t.id}"]{${parts.join(";")}}`;
  }).join("\n");
}
