# Tenant onboarding progress — platform admin Organizations (Chrono wiring)

> **Status: Revised after plan-audit (round 1) — audited, findings folded in, not yet
> re-audited.** **Depends on**
> `.ai/plans/agora/active/platform-admin-onboarding-progress/README.md` landing first
> (Phases 1-2 there: the foundation resolver, contracts, and route wiring this plan
> wires into). No branch/worktree/code exists yet.
>
> **Round-1 audit findings folded in:**
> 1. **Blocker — vacuous cross-tenant e2e assertion.** Chrono's seed produces exactly
>    two distinct onboarding fractions across its four tenants (`gaming`/`acme` both at
>    4/7, `contoso`/`globex` both at 0/7) — comparing a real fraction against a `0/7`
>    tenant proves nothing (indistinguishable from "the registry was never wired up").
>    Fixed: Phase 2's e2e spec now creates its own two differentiated, non-zero-fraction
>    tenants at runtime (mirroring the existing
>    `apps/chrono-web/e2e/tests/onboarding/onboarding-checklist.spec.ts:208-247`
>    pattern) instead of relying on the shared seed.
> 2. **Condition — "byte-identical pages" claim was false.** The two admin pages differ
>    in import depth, route-group folder, redirect targets, copy ("workspace" vs
>    "business"), and dialog layout. Fixed: Phase 1 now names two precise insertion
>    points instead of "port the exact diff."
> 3. **Condition — isolation claim needed correcting for `inviteStaff`.** That probe
>    reads non-RLS-scoped foundation tables (`member`/`invitation`) — filter-only
>    isolation, not RLS. Its actual defect (opening a second pooled connection while
>    holding the resolver's transaction — a **pre-existing latent hazard already present
>    in Chrono's shipped tenant-dashboard resolver**, just never exercised under the
>    enforced e2e harness's single-connection mode) is fixed here as a new **Phase 0**,
>    since this plan's own new admin-list route is what would first trigger it under
>    `pnpm --filter @agora/chrono-api test:e2e`.
> 4. **Condition — registry should use the shipped builder.** Fixed: Phase 1 exports
>    `CHRONO_ONBOARDING_REGISTRY = buildOnboardingChecklistRegistry(CHRONO_ONBOARDING_ITEMS)`
>    instead of hand-building `{ items, keys: Object.keys(...) }` at the mount site.
> 5. **Condition — verification commands weren't runnable.** Fixed below with the
>    actual Chrono-specific scripts (root `pnpm dev`/`db:seed` target `@agora/api`, not
>    Chrono; both web apps bind port 3000, so they cannot run side by side).
> 6. **Condition — role-gate step wasn't a gate test.** Fixed: stated plainly as
>    inherited coverage, not relabeled as a new gate.
> 7. **Condition — Concreteness Gate gaps in the e2e phase.** Fixed: Out-of-Scope,
>    concrete acceptance criteria, and a `data-testid` selector strategy added (relies
>    on Phase 3's `data-testid`s from the companion plan).
> 8. **Risk — two fixture-determinism hazards** (branch/station auto-provisioning races
>    a "fresh tenant is at 0/7" assumption; the `pairDevice` probe intentionally reads a
>    different table than the seed writes to). Noted explicitly so the e2e spec and
>    acceptance criteria don't fight the codebase's existing, intentional behavior.

## Context

The companion agora plan adds a generic `onboarding?: OnboardingChecklistRegistry<OnboardingProbeItem>`
option to `platformRoutes()` (`packages/agora/src/admin/platform-admin/routes/platform.ts`)
and the `onboarding: { completedCount, total, items? }` fields to the
`PlatformOrgSummary`/`PlatformOrgDetail` contracts, defaulting to the empty foundation
registry so the neutral `apps/agora-api` scaffold renders "—". Chrono already has a
real, shipped onboarding checklist — `CHRONO_ONBOARDING_ITEMS`
(`apps/chrono-api/src/modules/onboarding/contracts.ts`, 7 items across Business/Team/
Trading stages, each with a `probe(tx, tenantId) => Promise<boolean>`) — used today only
by its tenant-facing dashboard widget
(`apps/chrono-api/src/modules/onboarding/service.ts`). This plan wires that existing
registry into Chrono's own `platformAdminRoutes()` call and ports the onboarding UI into
`apps/chrono-web`'s copy of the same two admin pages — plus a required prerequisite fix
to a pre-existing connection-handling defect in one of the seven probes, surfaced only
because this plan is the first caller to exercise that probe under the enforced,
connection-constrained e2e harness.

## Pass 1 — Workflow Analysis

Same actors/workflow as the agora plan (a platform admin viewing `/admin/organizations`
or an org detail page). Chrono-specific additions:

- **Tenant isolation, precisely characterized.** Six of Chrono's seven probes
  (`createBranch`, `addStationGroup`, `addStation`, `addProducts`, `pairDevice`,
  `openShift`) read RLS-forced Chrono tables through the resolver's `withTenant`
  transaction — fully RLS-covered, same guarantee as every other tenant-scoped read.
  The seventh, `inviteStaff`, reads `member`/`invitation` — foundation tables that carry
  **no** RLS policy at all (`.ai/rules/tenant.md`) — so its isolation is, and remains,
  filter-only (`WHERE organizationId = tenantId`), regardless of which connection
  executes the query. Phase 0 below changes *which connection* runs that query (fixing
  a connection-handling defect); it does not change this isolation characterization.
- **Fixture-determinism hazards** (do not fight these in the e2e spec):
  - `apps/chrono-web/e2e/tests/branches/signup-default-provisioning.spec.ts:5-7`
    auto-provisions a "Main" branch + Regular/Premium/VIP station groups on a fresh
    tenant's first `/admin` load. A brand-new Chrono tenant therefore settles at **2/7**
    (`createBranch` + `addStationGroup` done), not 0/7, once that fire-and-forget
    provisioning completes — the e2e spec (Phase 2) must poll to a settled state rather
    than assert a specific starting fraction for a freshly-signed-up tenant.
  - `pairDevice` deliberately probes `chronoDeviceProvisioningToken`, not `chronoDevice`
    (`contracts.ts:135-146`, with its own comment explaining why) — a tenant with paired
    devices but no live provisioning token still shows this step as not-done. This is
    existing, intentional behavior; an acceptance criterion that says "matches what the
    tenant actually has provisioned" must not be read as "matches what a human would
    intuitively expect," or an implementer will mistake this for a bug to fix.

## Pass 2 — Technical Planning

### Files touched

- `apps/chrono-api/src/modules/onboarding/contracts.ts` — fix `inviteStaff`'s probe to
  use its `tx` parameter instead of the module-level `adminDb` import (Phase 0); add
  `CHRONO_ONBOARDING_REGISTRY` export (Phase 1).
- `apps/chrono-api/src/app.ts` — wire the registry into `platformAdminRoutes(...)`
  (Phase 1).
- `apps/chrono-web/src/app/(saas-admin)/admin/organizations/page.tsx` — insert the
  onboarding column into the existing `columns` array.
- `apps/chrono-web/src/app/(saas-admin)/admin/organizations/[id]/page.tsx` — insert the
  onboarding card next to the existing Feature-flags card.
- `apps/chrono-web/e2e/tests/platform-admin/organizations-onboarding.spec.ts` (new).

### Design

**Phase 0 — the actual root fix.** `inviteStaff`'s probe
(`apps/chrono-api/src/modules/onboarding/contracts.ts:92-110`) currently does:

```ts
probe: async (_tx, tenantId) => {
  const [memberCount] = await adminDb
    .select({ n: count() })
    .from(base.member)
    .where(eq(base.member.organizationId, tenantId));
  // ...second adminDb query for invitation...
}
```

`_tx` is received and ignored; both reads go through the module-level `adminDb` client
instead. `adminDb` and the tenant pool (`db`, what `withTenant` checks a connection out
of) are **the same pool** whenever `DATABASE_URL_ADMIN` is unset — which is exactly how
`apps/chrono-api/src/e2e/run.ts` configures itself (`delete
process.env.DATABASE_URL_ADMIN`, `DB_POOL_MAX = "1"`). Any caller that wraps this probe
in `withTenant` (the existing tenant-dashboard resolver today; this plan's new
platform-admin resolver tomorrow) holds the transaction's one connection while awaiting
a second acquisition from the same one-connection pool — a deadlock, not merely a slow
query. The fix is mechanical and behavior-preserving: run both reads through the
supplied `tx` instead of `adminDb`. `member`/`invitation` carry no RLS policy, so
running the identical, identically-filtered query through `tx` instead of `adminDb`
changes nothing about isolation (still filter-only, as documented above) — it only
removes the second connection acquisition:

```ts
probe: async (tx, tenantId) => {
  const [memberCount] = await tx
    .select({ n: count() })
    .from(base.member)
    .where(eq(base.member.organizationId, tenantId));
  if ((memberCount?.n ?? 0) > 1) return true;
  return exists(
    tx
      .select({ id: base.invitation.id })
      .from(base.invitation)
      .where(and(eq(base.invitation.organizationId, tenantId), eq(base.invitation.status, "pending")))
      .limit(1),
  );
},
```

(`base` here is whatever the file already imports `member`/`invitation` from — this
removes the need for the `adminDb` import in this one probe; keep it if other code in
the file still uses it.) This is a pre-existing shipped-code fix, not something
introduced by adding the admin surface — it is included here because this plan's new
call path is what would first trigger it under the enforced gate.

**Registry wiring** (`app.ts:1179`, currently
`.route("/rpc-admin", platformAdminRoutes({ lifecycle }))`):

```ts
import { CHRONO_ONBOARDING_REGISTRY } from "./modules/onboarding/contracts";
// ...
.route("/rpc-admin", platformAdminRoutes({ lifecycle, onboarding: CHRONO_ONBOARDING_REGISTRY }))
```

Add to `contracts.ts`: `export const CHRONO_ONBOARDING_REGISTRY =
buildOnboardingChecklistRegistry(CHRONO_ONBOARDING_ITEMS);` — using the foundation's
existing builder (`agora`'s `buildOnboardingChecklistRegistry`, previously unused by any
app) rather than hand-constructing `{ items, keys }`, matching
`.ai/rules/business-app.md`'s extension-seam convention (`CHRONO_FEATURE_FLAGS` /
`CHRONO_MODULES` follow the same pattern in `apps/chrono-api/src/contracts/
extensions.ts` — this export can live there instead if that is the more consistent
location; confirm at implementation time). `CHRONO_ONBOARDING_ITEMS` already satisfies
`OnboardingProbeItem` structurally (label, description, href, stage,
requiredPermission, wizardStep, probe) — no other changes needed to the item
definitions themselves.

**UI port — precise insertion points, not a blind diff.** The two admin pages are
**not** identical between `apps/agora-web` and `apps/chrono-web` (different import
depth, route-group folder, `/dashboard` vs `/admin` URLs, "workspace" vs "business"
copy, dialog layout) — a whole-file or literal-diff port breaks the build or silently
reverts Chrono's own wording. The two regions this feature actually touches **are**
currently equivalent in shape between the two apps, so port only those:

- `organizations/page.tsx`'s `columns: DataTableColumn<OrgSummary>[]` array — insert the
  new onboarding column after the `memberCount` entry, before `status` (mirror the
  companion plan's Phase 3 column definition exactly, including `data-testid="org-onboarding"`).
- `[id]/page.tsx` — insert the onboarding checklist card adjacent to the existing
  Feature-flags card (mirror the companion plan's Phase 3 card exactly, including
  `data-testid="org-onboarding-checklist"`).

No other hunk is carried over. Any user-facing string that the agora-web version renders
as "workspace" must read "business" here, matching this page's existing copy.

### Out of scope

- Changing `CHRONO_ONBOARDING_ITEMS`'s item set, stages, or the six probes that don't
  need Phase 0's fix.
- Refactoring `resolveOnboardingState` (the tenant-dashboard widget) to reuse the
  foundation's `resolveOnboardingProgress`/`resolveOnboardingProgressBatch` — optional
  future cleanup, not required here (though it would independently benefit from Phase
  0's fix, since it wraps the same probe in `withTenant` today).
- Differentiating the shared seed tenants (`contoso`/`globex`) to produce non-zero
  onboarding fractions — the e2e spec creates its own fixtures instead (see Phase 2),
  so this is not needed.

## Phase design

### Phase 0 — Fix the `inviteStaff` connection-nesting defect (prerequisite)

**Files to update**: `apps/chrono-api/src/modules/onboarding/contracts.ts`.

**Step-by-step tasks**: change `inviteStaff.probe` to run both reads through its `tx`
parameter instead of the module-level `adminDb` client, as shown in Design above. Remove
the now-stale doc comment line claiming "filtered explicitly by organizationId via
adminDb, never withTenant" and replace it with a note that the query now runs through
the caller's own transaction.

**Acceptance criteria**: `apps/chrono-api/src/modules/onboarding/routes.test.ts` (the
existing unit test covering this file) still passes unmodified; a new or extended test
in that file simulates a single-connection pool (or asserts, via a spy, that the probe
issues no query against a client other than the one it was handed) to prove the nesting
hazard is actually gone, not just "still passes today by luck."

**Verification commands**: `pnpm --filter @agora/chrono-api test`; `pnpm typecheck`.

**Out-of-scope**: registry wiring (Phase 1); this phase touches no route, no contract,
no permission.

### Phase 1 — Wire the registry

**Files to update**: `apps/chrono-api/src/modules/onboarding/contracts.ts` (add the
`CHRONO_ONBOARDING_REGISTRY` export — or `apps/chrono-api/src/contracts/extensions.ts`,
whichever is the more consistent location at implementation time), `apps/chrono-api/src/app.ts`.

**Step-by-step tasks**: add the `buildOnboardingChecklistRegistry(...)` export; import
it into `app.ts`; pass it into the existing `platformAdminRoutes({ lifecycle })` call as
shown in Design.

**Acceptance criteria**: `GET /rpc-admin/organizations` against a running
`apps/chrono-api` returns `total: 7` for every seeded tenant, with `completedCount`
matching each seeded tenant's actual state (per the fixture matrix in this plan's audit
history: `gaming`/`acme` at 4, `contoso`/`globex` at 0 — expected and correct given the
current seed, not a bug); the detail route's `items` array names all 7 Chrono steps with
`done` values consistent with each seeded tenant's provisioned data, honoring the two
fixture-determinism notes in Pass 1 (the `pairDevice` table distinction in particular).

**Verification commands**: `pnpm typecheck`; **`pnpm --filter @agora/chrono-api
test:e2e`** — this is the enforced-gate run that would have hit the Phase 0 hazard had
it not already been fixed; running it here is the actual proof that the fix holds under
this route's real call pattern, not just Phase 0's isolated unit test. Manual
`curl`/browser hit against a running `apps/chrono-api` dev server as a secondary check.

**Out-of-scope**: UI (Phase 2).

### Phase 2 — UI port

**Files to update**:
`apps/chrono-web/src/app/(saas-admin)/admin/organizations/page.tsx`,
`apps/chrono-web/src/app/(saas-admin)/admin/organizations/[id]/page.tsx`.

**Step-by-step tasks**: insert the two precise hunks named in Design (column into the
`columns` array; card next to the Feature-flags card). Confirm both carry the same
`data-testid`s as the companion plan's Phase 3.

**Acceptance criteria**: `/admin/organizations` shows real fractions (e.g. "4/7") for
`gaming`/`acme`, "0/7" for `contoso`/`globex` (not "—" — these tenants have a registered
checklist, they simply haven't completed any of it); the detail page's checklist card
lists all 7 items with correct done/pending state per tenant; dark/light theme both
readable; no other page copy or layout changed.

**Verification commands**: `pnpm typecheck`; manual browser check — **stop any running
`apps/agora-web`/`apps/agora-api` dev servers first** (both web apps bind port 3000, per
`apps/chrono-web/package.json`'s and `apps/agora-web/package.json`'s identical `next dev
--port 3000`), then `pnpm --parallel --filter @agora/chrono-api --filter
@agora/chrono-web dev`, then `pnpm --filter @agora/chrono-api seed` (root `pnpm db:seed`
targets `@agora/api`, not Chrono — use the Chrono-scoped script directly), then check
`http://localtest.me:3000/admin/organizations` (confirmed to resolve to the
platform-admin surface on the apex host, not rewritten to `/dashboard` —
`apps/chrono-web/next.config.ts`'s `/admin/:path*` rewrite is scoped `missing:
notApex`).

**Out-of-scope**: e2e automation (Phase 3).

### Phase 3 — E2E

**Files to update**:
`apps/chrono-web/e2e/tests/platform-admin/organizations-onboarding.spec.ts` (new).

**Step-by-step tasks**: the spec builds its own fixtures rather than relying on the
shared seed (which cannot produce a non-vacuous cross-tenant comparison — see this
plan's audit history, finding 1):
1. Sign up two throwaway tenants (A and B), following the existing pattern in
   `apps/chrono-web/e2e/tests/onboarding/onboarding-checklist.spec.ts:208-247`.
2. Drive tenant A through a different, larger set of real onboarding steps than tenant
   B via the actual dashboard (never write directly to the database) — both ending at a
   **non-zero** fraction, and at **different** fractions from each other, with
   overlapping-but-not-identical `done` sets. Poll for the auto-provisioning steps
   (branch/station-group) to settle before asserting a starting state, per Pass 1's
   fixture-determinism note.
3. Assert, as the platform admin: the list row for A shows A's real fraction
   (`[data-testid="org-onboarding"]`) and for B shows B's — different values, both
   non-zero.
4. Assert the detail page's `[data-testid="org-onboarding-checklist"]` for A and B each
   list the correct per-item done/pending state, and that the two tenants' `done` sets
   are not identical.
5. Cross-tenant isolation, concretely: give tenant A a second staff member (flipping its
   `inviteStaff` item to done) and assert tenant B's `inviteStaff` item is unaffected —
   this is the specific item Phase 0 touches, so it is the one most worth a direct
   assertion.

**Acceptance criteria**: role-gate coverage is inherited from the existing `organization:
["read"]` gate — this plan introduces no new permission, so there is no new gate test to
write here; a `viewer`-role platform admin seeing the same data is a regression check,
not a gate test (`.ai/rules/rbac.md`'s gate-test definition requires a check that fails
when a permission is removed — there is no new permission to remove).

**Verification commands**: `pnpm --filter @agora/chrono-web e2e` (headed, `slowMo`,
`workers: 1`, no `webServer` — start the Chrono dev servers first per Phase 2's
verification block).

**Execution start point**: Phase 0, `apps/chrono-api/src/modules/onboarding/contracts.ts`.

## After implementation

No schema/RLS/migration change — running `pnpm --filter @agora/chrono-api rls:proof`
once after this plan lands costs nothing and confirms no regression, though it is not
strictly required by this plan's own changes (Phase 0 changes which connection a probe
uses, not any RLS policy).
