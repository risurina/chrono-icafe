# chrono-email-theming — Jules delegation handover

Implementation delegated to Jules per developer instruction ("use jules for now").
Claude Code retains planning, plan-audit, review, and verification per
`.ai/rules/feature-planning.md`'s Model & Delegation Policy — Jules owns only the
mechanical phase implementation below. No phase touches schema/RLS/tenant-isolation/
permission-gate design, so all 4 are Jules-eligible.

Plan passed 2 audit rounds (1st: NEEDS REVISION → resolved; 2nd, after the
`email-design-system` dependency landed: NEEDS REVISION → resolved, with the developer
confirming the real owl-logo URL and the `business-lead` call-site addition). 4 phases
total. One Jules session per phase.

## Phase 1 — Share `CHRONO_THEME_PRESETS` with `chrono-api`

- Status: **done**. Session `16758341622786987464` completed, pulled and
  applied. Content moved byte-identical (diffed against the original), both
  real importers (`layout.tsx`, `theme-picker.tsx`) confirmed named-export
  only. `pnpm --filter @agora/chrono-api typecheck`, `pnpm --filter
  @agora/chrono-web typecheck`, and `pnpm --filter @agora/chrono-web build`
  (the real bundler-resolution check for the new client-bundle value import)
  all pass. Committed `adffa133`.

## Phase 2 — `resolveChronoEmailTheme` + boot-time registration

- Status: **done**. Session `13227066584702928790` completed, pulled and
  applied. Diff matches spec exactly; manually traced the alpha-compositing
  math for a real neon-green 8-digit border value and confirmed a sane
  6-digit result. `pnpm --filter @agora/chrono-api typecheck` passes.
  Committed `95d08d05`.

## Phase 3 — Migrate Chrono's own ad hoc email call sites (4 sites, incl. business-lead)

- Status: **done**. Session `9177594113553321491` completed, pulled and
  applied. Grep-confirmed exactly 4 `renderBrandedEmail` sites + 2 owl-logo
  files (no third missed site). `pnpm --filter @agora/chrono-api typecheck`
  passes. Committed `e7e5449a`.

## Phase 4 — Verification + docs

- Status: **done**. Fixed `apps/chrono-api/AGENTS.md`'s stale theme-preset
  location claim, added a note on email theming, `pnpm typecheck` re-verified
  independently (7/7 tasks). Read (not executed, per plan's own note that
  this suite is manual)
  `apps/chrono-web/e2e/tests/platform-admin/notification-templates.spec.ts` —
  no plausible regression (entirely independent of the theme-preset
  resolver). Committed `d469b83a`.

All 4 phases now landed. Next: `branch-reviewer` on the whole plan, then
fix-review if needed, then wrap-up/archive.
