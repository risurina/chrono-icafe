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

- Status: fired 2026-09-06, awaiting completion.
- Session id: `9177594113553321491` — https://jules.google.com/session/9177594113553321491

## Phase 4 — Verification + docs

- Status: not yet fired.
