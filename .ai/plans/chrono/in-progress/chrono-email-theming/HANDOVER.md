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

- Status: fired 2026-09-06, awaiting completion.
- Session id: `16758341622786987464` — https://jules.google.com/session/16758341622786987464

## Phase 2 — `resolveChronoEmailTheme` + boot-time registration

- Status: not yet fired.

## Phase 3 — Migrate Chrono's own ad hoc email call sites (4 sites, incl. business-lead)

- Status: not yet fired.

## Phase 4 — Verification + docs

- Status: not yet fired.
