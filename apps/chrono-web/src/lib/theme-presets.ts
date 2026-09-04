import { buildThemePresetRegistry } from "agora";

/**
 * Chrono's theme palettes.
 *
 * The foundation owns the mechanism (`buildThemePresetRegistry`,
 * `themePresetCss`); this file owns only the colours. A tenant picks one and it
 * re-skins the whole surface, including every `.premium-*` utility, because
 * those are all driven by `var(--primary)` through `color-mix()`.
 *
 * `elegant-gold` is the default and its values already ship in
 * `app/globals.css`, so `themePresetCss()` emits nothing for it — the
 * stylesheet stays the real fallback rather than being shadowed by a duplicate
 * `<style>` tag on every render.
 *
 * ── Adding a palette ────────────────────────────────────────────────────────
 * Every light-mode text pair must clear WCAG AA (4.5:1), and every non-text
 * role that carries meaning — `ring` above all, it is the focus indicator —
 * must clear 3:1. Check before merging; see
 * `.ai/plans/chrono/archive/chrono-theme-colors/palette-source.md` for the
 * method and the corrections elegant-gold itself needed.
 */

/** Verbatim from `app/globals.css`'s `:root` — the shipped light palette. */
const ELEGANT_GOLD_LIGHT = {
  background: "#faf9f6",
  foreground: "#1c1917",
  card: "#fff",
  "card-foreground": "#1c1917",
  popover: "#fff",
  "popover-foreground": "#1c1917",
  primary: "#8a6508",
  "primary-foreground": "#faf9f6",
  secondary: "#f5f5f4",
  "secondary-foreground": "#8a6508",
  muted: "#f5f5f4",
  "muted-foreground": "#6b6660",
  accent: "#f5f5f4",
  "accent-foreground": "#8a6508",
  destructive: "#c0392b",
  border: "#b8860b26",
  input: "#b8860b26",
  ring: "#b8860b",
  "chart-1": "#b8860b",
  "chart-2": "#10b981",
  "chart-3": "#3b82f6",
  "chart-4": "#f59e0b",
  "chart-5": "#ef4444",
  sidebar: "#fff",
  "sidebar-foreground": "#1c1917",
  "sidebar-primary": "#8a6508",
  "sidebar-primary-foreground": "#faf9f6",
  "sidebar-accent": "#f5f5f4",
  "sidebar-accent-foreground": "#8a6508",
  "sidebar-border": "#b8860b26",
  "sidebar-ring": "#b8860b",
} as const;

/** Verbatim from `app/globals.css`'s `.dark`. */
const ELEGANT_GOLD_DARK = {
  background: "#080806",
  foreground: "#f8f1e3",
  card: "#080806",
  "card-foreground": "#f8f1e3",
  popover: "#17140d",
  "popover-foreground": "#f8f1e3",
  primary: "#d6a84f",
  "primary-foreground": "#080806",
  secondary: "#201b10",
  "secondary-foreground": "#f7d77a",
  muted: "#11100c",
  "muted-foreground": "#b8aa90",
  accent: "#201b10",
  "accent-foreground": "#d6a84f",
  destructive: "#d9534f",
  border: "#d6a84f38",
  input: "#d6a84f38",
  ring: "#d6a84f",
  "chart-1": "#d6a84f",
  "chart-2": "#34d399",
  "chart-3": "#60a5fa",
  "chart-4": "#fbbf24",
  "chart-5": "#f87171",
  sidebar: "#11100c",
  "sidebar-foreground": "#f8f1e3",
  "sidebar-primary": "#d6a84f",
  "sidebar-primary-foreground": "#080806",
  "sidebar-accent": "#201b10",
  "sidebar-accent-foreground": "#d6a84f",
  "sidebar-border": "#d6a84f38",
  "sidebar-ring": "#d6a84f",
} as const;

/**
 * Neon green. Contrast measured with the WCAG 2.x relative-luminance formula:
 * `primary-foreground` on `primary` 5.26:1, `secondary-foreground`/
 * `accent-foreground` 4.90:1, `muted-foreground` 5.33:1 — all clear AA.
 *
 * `ring` and `chart-1` use `#0f7a3d`, **not** the brighter `#22c55e`: that
 * measures 2.21:1 on `background` and 2.28:1 on `card`, failing the 3:1
 * non-text floor a focus ring has to meet.
 */
const NEON_GREEN_LIGHT = {
  background: "#f7fdf9",
  foreground: "#0f1f13",
  card: "#fff",
  "card-foreground": "#0f1f13",
  popover: "#fff",
  "popover-foreground": "#0f1f13",
  primary: "#0f7a3d",
  "primary-foreground": "#f7fdf9",
  secondary: "#e8f7ee",
  "secondary-foreground": "#0f7a3d",
  muted: "#e8f7ee",
  "muted-foreground": "#4d6b57",
  accent: "#e8f7ee",
  "accent-foreground": "#0f7a3d",
  destructive: "#c0392b",
  border: "#22c55e26",
  input: "#22c55e26",
  ring: "#0f7a3d",
  "chart-1": "#0f7a3d",
  "chart-2": "#3b82f6",
  "chart-3": "#f59e0b",
  "chart-4": "#a855f7",
  "chart-5": "#ef4444",
  sidebar: "#fff",
  "sidebar-foreground": "#0f1f13",
  "sidebar-primary": "#0f7a3d",
  "sidebar-primary-foreground": "#f7fdf9",
  "sidebar-accent": "#e8f7ee",
  "sidebar-accent-foreground": "#0f7a3d",
  "sidebar-border": "#22c55e26",
  "sidebar-ring": "#0f7a3d",
} as const;

/** `primary` on `background` 11.60:1, `foreground` on `background` 17.69:1. */
const NEON_GREEN_DARK = {
  background: "#06120a",
  foreground: "#e7fbee",
  card: "#0d1f14",
  "card-foreground": "#e7fbee",
  popover: "#0d1f14",
  "popover-foreground": "#e7fbee",
  primary: "#39e675",
  "primary-foreground": "#06120a",
  secondary: "#12331e",
  "secondary-foreground": "#8ff5b0",
  muted: "#0a1a11",
  "muted-foreground": "#9fd6b3",
  accent: "#12331e",
  "accent-foreground": "#39e675",
  destructive: "#f2685c",
  border: "#39e67538",
  input: "#39e67538",
  ring: "#39e675",
  "chart-1": "#39e675",
  "chart-2": "#60a5fa",
  "chart-3": "#fbbf24",
  "chart-4": "#c084fc",
  "chart-5": "#f87171",
  sidebar: "#0a1a11",
  "sidebar-foreground": "#e7fbee",
  "sidebar-primary": "#39e675",
  "sidebar-primary-foreground": "#06120a",
  "sidebar-accent": "#12331e",
  "sidebar-accent-foreground": "#39e675",
  "sidebar-border": "#39e67538",
  "sidebar-ring": "#39e675",
} as const;

export const CHRONO_THEME_PRESETS = buildThemePresetRegistry(
  {
    "elegant-gold": {
      key: "elegant-gold",
      label: "Elegant Gold",
      light: { ...ELEGANT_GOLD_LIGHT },
      dark: { ...ELEGANT_GOLD_DARK },
    },
    "neon-green": {
      key: "neon-green",
      label: "Neon Green",
      light: { ...NEON_GREEN_LIGHT },
      dark: { ...NEON_GREEN_DARK },
    },
  },
  "elegant-gold",
);

/** Swatch colour for a preset, for the dashboard picker. */
export function presetSwatch(key: string): string {
  return CHRONO_THEME_PRESETS.presets[key]?.light.primary ?? "#8a6508";
}
