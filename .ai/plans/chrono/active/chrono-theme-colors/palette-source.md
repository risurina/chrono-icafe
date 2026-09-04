# Elegant-gold palette — source

Extracted from the live karta-oikos/chrono production stylesheet at
https://chrono.izur.com.ph/_next/static/chunks/15_6pk03z6c4i.css
(fetched 2026-09-03).

## Raw extracted `:root` block (light)

```css
:root{
  --lightningcss-light:initial;--lightningcss-dark: ;color-scheme:light;
  --background:#faf9f6;--foreground:#1c1917;--card:#fff;--card-foreground:#1c1917;
  --popover:#fff;--popover-foreground:#1c1917;--primary:#b8860b;--primary-rgb:184, 134, 11;
  --primary-foreground:#faf9f6;--secondary:#f5f5f4;--secondary-foreground:#b8860b;
  --muted:#f5f5f4;--muted-foreground:#78716c;--accent:#f5f5f4;--accent-foreground:#b8860b;
  --destructive:#ef4444;--destructive-rgb:239, 68, 68;--destructive-foreground:#faf9f6;
  --border:#b8860b26;--input:#b8860b26;--ring:#b8860b;--radius:.75rem;
  --sidebar:#fff;--sidebar-foreground:#1c1917;--sidebar-primary:#b8860b;
  --sidebar-primary-foreground:#faf9f6;--sidebar-accent:#f5f5f4;--sidebar-accent-foreground:#b8860b;
  --sidebar-border:#b8860b26;--sidebar-ring:#b8860b;
  --chart-1:#b8860b;--chart-2:#10b981;--chart-3:#3b82f6;--chart-4:#f59e0b;--chart-5:#ef4444;
}
```

## Raw extracted `.dark` block

```css
.dark{
  --lightningcss-light: ;--lightningcss-dark:initial;color-scheme:dark;
  --background:#080806;--foreground:#f8f1e3;--card:#17140d;--card-foreground:#f8f1e3;
  --popover:#17140d;--popover-foreground:#f8f1e3;--primary:#d6a84f;--primary-rgb:214, 168, 79;
  --primary-foreground:#080806;--secondary:#201b10;--secondary-foreground:#f7d77a;
  --muted:#11100c;--muted-foreground:#b8aa90;--accent:#201b10;--accent-foreground:#d6a84f;
  --destructive:#d9534f;--destructive-foreground:#f8f1e3;--border:#d6a84f38;--input:#d6a84f38;
  --ring:#d6a84f;--radius:.75rem;--sidebar:#11100c;--sidebar-foreground:#f8f1e3;
  --sidebar-primary:#d6a84f;--sidebar-primary-foreground:#080806;--sidebar-accent:#201b10;
  --sidebar-accent-foreground:#d6a84f;--sidebar-border:#d6a84f38;--sidebar-ring:#d6a84f;
  --chart-1:#d6a84f;--chart-2:#34d399;--chart-3:#60a5fa;--chart-4:#fbbf24;--chart-5:#f87171;
}
```

## Verbatim vs. derived

- **Dark block: verbatim.** All values (`#080806`, `#17140d`, `#f8f1e3`, `#d6a84f`,
  `#201b10`, `#11100c`, `#b8aa90`, `#f7d77a`, `#d9534f`) are taken as-is — measured
  contrast is clean (7.8–17.8:1) so no adjustment needed.
- **Light block: mostly verbatim, three text-role values darkened for accessibility.**
  The extracted light values reuse Tailwind's stock palette
  (`#f5f5f4`=stone-100, `#78716c`=stone-500, `#1c1917`=stone-900, `#ef4444`=red-500,
  `#10b981`, `#3b82f6`, `#f59e0b`) plus the CSS named color `darkgoldenrod` (`#b8860b`)
  as the brand gold. The live site's own `primary`/`secondary-foreground`/
  `accent-foreground` all use `#b8860b` at ~3:1 contrast against their backgrounds,
  which fails WCAG AA text contrast (4.5:1) — see plan-audit Finding 2. This plan
  **deviates from the verbatim source** in three ways, all documented in `README.md`,
  Phase 1:
  1. Five *text/foreground* roles use a darker gold, `#8a6508`, instead of the
     source's `#b8860b`: `primary`, `secondary-foreground`, `accent-foreground`,
     `sidebar-primary`, `sidebar-accent-foreground`. `#b8860b` is kept for the four
     *decorative* roles (`ring`, `border`, `input`, `chart-1`) where only the 3:1
     non-text floor applies and `#b8860b` already clears it.
  2. `destructive` uses `#c0392b` instead of the source's `#ef4444` (3.76:1, fails
     AA text) — `#c0392b` clears 4.5:1 on both `card` and `background`, since
     `agora/ui` renders this token as text (error messages) more often than as a
     filled surface.
  3. `muted-foreground` uses `#6b6660` instead of the source's `#78716c` (4.40:1 on
     `muted`, marginally fails AA) — flagged during branch review since the pair
     renders directly in `agora/ui`'s tabs and notification-bell components.
     `#6b6660` clears ~5.2:1 on `muted` and ~5.4:1 on `background`.
  All three are deliberate, documented accessibility fixes, not copy errors.
