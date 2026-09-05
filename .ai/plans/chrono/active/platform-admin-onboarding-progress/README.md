# Tenant onboarding progress — platform admin Organizations (Chrono wiring)

> **Status: Draft — written and accepted by the developer, not yet audited.**
> **Depends on** `.ai/plans/agora/active/platform-admin-onboarding-progress/README.md`
> landing first (the foundation resolver, contracts, and route wiring this plan wires
> into). No branch/worktree/code exists yet.

## Context

The companion agora plan adds a generic `onboarding?: OnboardingProbeRegistry` option to
`platformRoutes()` (`packages/agora/src/admin/platform-admin/routes/platform.ts`) and the
`{ completedCount, total, items }` fields to the `PlatformOrgSummary`/`PlatformOrgDetail`
contracts, defaulting to an empty registry so the neutral `apps/agora-api` scaffold
renders "—". Chrono already has a real, shipped onboarding checklist —
`CHRONO_ONBOARDING_ITEMS` (`apps/chrono-api/src/modules/onboarding/contracts.ts`, 7 items
across Business/Team/Trading stages, each with a `probe(tx, tenantId) => Promise<boolean>`)
— used today only by its tenant-facing dashboard widget
(`apps/chrono-api/src/modules/onboarding/service.ts`). This plan is the small, mechanical
half: wire that existing registry into Chrono's own `platformAdminRoutes()` call, and
port the identical UI diff from `apps/agora-web` into `apps/chrono-web`'s copy of the
same two admin pages (confirmed byte-identical clones today — the admin surface is
duplicated per app, not shared code, per `.ai/rules/business-app.md`'s "inherited
platform-admin surface — reused as-is" convention: when the foundation surface evolves,
every app's copy evolves identically).

## Pass 1 — Workflow Analysis

Same actors/workflow as the agora plan (a platform admin viewing `/admin/organizations`
or an org detail page). The Chrono-specific addition to consider:

- **Tenant isolation, concretely proven**: Chrono has real, differently-shaped seeded
  tenants (`acme`, `contoso`, `globex` — `apps/agora-api/src/seed.ts`'s pattern, mirrored
  in Chrono's own seed) with different project/branch/station counts. This plan's e2e
  spec must assert tenant A's onboarding fraction never reflects tenant B's data — the
  concrete version of the "tenant-isolation leak" failure case, worth a real assertion
  here even though the resolver's isolation is inherited from `withTenant` (no new RLS
  policy).
- **Stale item after registry drift**: if a Chrono onboarding item is later renamed or
  removed from `CHRONO_ONBOARDING_ITEMS`, the admin view must reflect the *current*
  registry (fewer/renamed items), never a stale cached count — this falls out of the
  resolver running live probes on every request (no caching), so no extra work is needed
  here; noted only so the audit step can confirm the assumption holds.

## Pass 2 — Technical Planning

### Files touched

- `apps/chrono-api/src/app.ts` — pass Chrono's registry into `platformAdminRoutes(...)`.
- `apps/chrono-web/src/app/(saas-admin)/admin/organizations/page.tsx` — port the list
  column.
- `apps/chrono-web/src/app/(saas-admin)/admin/organizations/[id]/page.tsx` — port the
  detail card.
- `apps/chrono-web/e2e/tests/platform-admin/organizations-onboarding.spec.ts` (new).

### Design

**Registry wiring** (`app.ts:1179`, currently
`.route("/rpc-admin", platformAdminRoutes({ lifecycle }))`): change to

```ts
.route(
  "/rpc-admin",
  platformAdminRoutes({
    lifecycle,
    onboarding: { items: CHRONO_ONBOARDING_ITEMS, keys: Object.keys(CHRONO_ONBOARDING_ITEMS) },
  }),
)
```

`CHRONO_ONBOARDING_ITEMS` already satisfies `OnboardingProbeItem` structurally (label,
description, href, stage, requiredPermission, wizardStep, probe) — **no changes needed**
to `apps/chrono-api/src/modules/onboarding/contracts.ts`. Import it into `app.ts` from
its existing module path.

**UI port**: apply the identical diff from the agora plan's Phase 3 to Chrono's own
copies of `organizations/page.tsx` and `organizations/[id]/page.tsx` — same column, same
badge variants, same card, same conditional hide-when-`total === 0` (which will now
never trigger for Chrono's own tenants, since every Chrono org has 7 registered items,
but keeping the guard is still correct in case a future tenant somehow resolves to zero).

### Out of scope

- Changing `CHRONO_ONBOARDING_ITEMS` itself (item set, stages, probes) — this plan only
  *surfaces* the existing checklist to platform admins, it does not redesign it.
- Refactoring `resolveOnboardingState` (the tenant-dashboard widget) to reuse the new
  foundation `resolveOnboardingProgress` — optional future cleanup, not required here.

## Phase design

### Phase 1 — Wire the registry

**Files to update**: `apps/chrono-api/src/app.ts`.

**Step-by-step tasks**: import `CHRONO_ONBOARDING_ITEMS`; pass it into the existing
`platformAdminRoutes({ lifecycle })` call as shown above.

**Acceptance criteria**: `GET /rpc-admin/organizations` against a running
`apps/chrono-api` returns real, non-zero `total` (7) and a plausible `completedCount` per
seeded tenant; the detail route's `items` array names all 7 Chrono steps with correct
`done` values matching what each seeded tenant actually has provisioned.

**Verification commands**: `pnpm typecheck`; manual `curl`/browser hit against a running
`apps/chrono-api` dev server, cross-checked against each seeded tenant's known fixture
data (e.g. `acme` has 3 projects/branches seeded vs. `globex`'s 1 — see
`apps/agora-api/src/seed.ts`'s pattern, mirrored for Chrono).

**Out-of-scope**: UI (Phase 2).

### Phase 2 — UI port

**Files to update**:
`apps/chrono-web/src/app/(saas-admin)/admin/organizations/page.tsx`,
`apps/chrono-web/src/app/(saas-admin)/admin/organizations/[id]/page.tsx`.

**Step-by-step tasks**: port the exact diff applied to agora-web's Phase 3 (list column
+ detail card) into these two files.

**Acceptance criteria**: `/admin/organizations` shows real fractions (e.g. "4/7") for
every seeded Chrono tenant; the detail page's checklist card lists all 7 items with
correct done/pending state; dark/light theme both readable.

**Verification commands**: `pnpm typecheck`; manual browser check at
`localtest.me:3000/admin/organizations` (Chrono dev server running on port 3000, per
`apps/chrono-web/package.json`'s `next dev --port 3000`).

**Out-of-scope**: e2e automation (Phase 3).

### Phase 3 — E2E

**Files to update**:
`apps/chrono-web/e2e/tests/platform-admin/organizations-onboarding.spec.ts` (new).

**Step-by-step tasks**: spec drives the real admin surface end to end —
1. Happy path: a seeded tenant's list-row fraction and detail-page breakdown match its
   known fixture state.
2. Role gate: inherited from the existing `organization: ["read"]` gate — confirm a
   `viewer`-role platform admin still sees the same data (read-only, no new gate).
3. Cross-tenant isolation: tenant A's fraction/items never change based on tenant B's
   data — the concrete assertion called for in Pass 1.

**Acceptance criteria**: spec passes.

**Verification commands**: the project's Playwright invocation per
`.ai/rules/e2e-testing.md`.

**Execution start point**: Phase 1, `apps/chrono-api/src/app.ts`.

## After implementation

No schema/RLS/migration change — running `pnpm --filter @agora/chrono-api rls:proof`
once after this phase costs nothing and confirms no regression, though it is not
strictly required by this plan's own changes.
