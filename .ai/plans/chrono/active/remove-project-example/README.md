# Chrono — remove the `project` scaffold example

**Type:** cleanup / de-scaffolding. No new behaviour.
**Answer to "can we just delete the page and the menu item?":** **no** — but yes, it
should go. `project` is wired into the app's isolation proof, its platform-admin usage
reporting, and its public REST API. Deleting the page alone leaves all of that live.

---

## Want it hidden *today*? There is a zero-code option.

`project` is already a registered **module** (`packages/agora/src/contracts/module-registry.ts:33`,
`featureFlagKey: "modules.project"`, `navHref: "/projects"`), and
`apps/chrono-web/src/app/dashboard/layout.tsx:151-172` already filters the nav entry when
that module is disabled for the tenant:

```ts
const project = modules.find((m) => m.key === "project");
if (project) setProjectsEnabled(project.enabled);
// …
const NAV = projectsEnabled ? BASE_NAV : BASE_NAV.filter(i => i.href !== "/projects");
```

So **turning the `project` module off for the Chrono tenant hides the menu entry with no
code change at all.** If the goal is "our customer shouldn't see this", do that now and
run this plan when convenient. It does not remove the route (someone typing the URL still
reaches the page) or any API surface — so it is a stopgap, not the fix.

---

## Why it is not a two-file delete

`grep -rIl project` finds **10 files in `apps/chrono-api/src`**, **9 in
`apps/chrono-web/src`**, and **8 web e2e specs**. Three of those couplings are load-bearing:

### 1. `rls-proof.ts` uses `project` as its probe table — **hard blocker**

`apps/chrono-api/src/rls-proof.ts:13,55-72,170-171,205` seeds probe rows into `project`
for both tenants and compares cross-tenant reads against them. This is the script
`AGENTS.md` requires to print `RLS PROOF: PASS ✅` after **any** tenancy/RLS/schema change
— the single most important guarantee in the repo.

Drop the table before repointing this and the proof does not merely fail, it stops being
runnable. Worse, `.ai/rules/database.md` warns the proof "must not pass vacuously" — a
half-migrated probe that silently reads an empty table would report success while proving
nothing. **This must be Phase 1, and nothing else may start before it is green.**

### 2. `app.ts` injects per-tenant project counts into foundation admin routes

`apps/chrono-api/src/app.ts:212-230,884` defines `projectCountsByTenant` and injects it
into the foundation's metrics/usage platform-admin routes, so `/admin/usage`,
`/admin/metrics` and the org detail page can report a per-tenant resource count without
the foundation importing this app's schema. Removing `project` removes that number from
three admin screens unless it is repointed.

### 3. `api-v1.ts` exposes `/projects` as a **public, versioned REST API**

`apps/chrono-api/src/routes/api-v1.ts:49-90` serves `GET`/`POST /api/v1/projects`, gated
and tenant-scoped, with an e2e spec (`e2e/tests/public-api/v1-projects.spec.ts`). Per
`.ai/rules/api.md` a public API is versioned precisely because third parties may consume
it. Removing it is a **breaking change for any API-key holder**, not an internal cleanup.
Confirm no key holder uses it before Phase 4 (see Open Questions).

### And one thing that must NOT be removed

`project` is a **foundation** permission (`packages/agora/src/auth/permissions.ts:46,76,88`
— statements plus staff and admin grants) and a **foundation** module-registry entry. It
is the scaffold's intended worked example, and `apps/agora-api` depends on it. **Do not
edit either foundation file.** Chrono removes its own *usage*; the vocabulary stays.

This leaves a deliberate, documented wart: `.ai/rules/rbac.md` says every action must map
to a real gate, and after this plan `project:create`/`project:delete` will have no route
**in Chrono** (they still do in the scaffold). That is the correct trade — the alternative
is a business app mutating shared foundation vocabulary, which
`.ai/rules/business-app.md` forbids outright. Recorded in Phase 6 rather than left for a
reviewer to trip over.

---

## Pass 1 — Workflow Analysis

**Who is affected:** tenant `staff`/`admin`/`owner` lose a nav entry and a page they have
no business reason to use. Platform admins lose a per-tenant count on three `/admin`
screens unless Phase 2 repoints it. Any external `/api/v1/projects` consumer breaks.

**What they see:** nothing, if the module flag is already off. Otherwise the Projects nav
entry and page disappear, and the dashboard Overview card stops showing a project count.

**Failure cases:** the dangerous one is ordering — dropping the table before repointing
`rls-proof` leaves the repo unable to prove tenant isolation, which is the one thing
`AGENTS.md` treats as non-negotiable. Every other failure is cosmetic by comparison.

**Audit / notifications:** `project.created` / `project.deleted` are emitted as tenant
webhook events (`rpc.ts:839,859`). Removing the routes removes those event types; a
tenant with a webhook endpoint subscribed to them stops receiving them. Check before
Phase 4.

---

## Pass 2 — Technical Planning

### Full inventory

**`apps/chrono-api/src`** — `rls-proof.ts`, `app.ts`, `routes/rpc.ts` (list ~533, create
~826, delete ~845), `routes/api-v1.ts`, `db/schema.ts` (table + `APP_TENANT_TABLES`),
`seed.ts`, `e2e/run.ts` (**81 references**), `e2e/permissions.test.ts`,
`modules/branch/routes.ts`, `modules/session/routes.ts` (incidental mentions — check
whether real coupling or comment).

**`apps/chrono-web/src`** — `app/dashboard/projects/page.tsx` (delete),
`app/dashboard/layout.tsx` (nav entry :61, breadcrumb :95, flag plumbing :151-172),
`app/dashboard/page.tsx` (Overview project-count card), `app/page.tsx`,
`app/admin/{metrics,usage,billing}/page.tsx`, `app/admin/organizations/[id]/page.tsx`,
`app/dashboard/settings/audit/page.tsx`.

**`apps/chrono-web/e2e/tests`** — `data-listing/projects-listing.spec.ts` and
`public-api/v1-projects.spec.ts` (delete); `modules/module-toggle.spec.ts`,
`impersonation/impersonation-scope.spec.ts`, `platform-admin/{metrics,usage}.spec.ts`,
`branches/branches.spec.ts`, `reservations/reservations.spec.ts` (repoint — these use
`project` as a convenient generic tenant resource, not as the subject under test).

### Replacement probe/count resource

`chronoBranch` is the natural stand-in for both `rls-proof` and the count provider: it is
tenant-scoped, RLS-forced, already in `APP_TENANT_TABLES`, has no dependency on any other
Chrono module, and every real Chrono tenant has at least one. Use it for both.

---

## Phase 1 — Repoint `rls-proof` to `chronoBranch` (**prerequisite — do this alone**)

**Files to update:** `apps/chrono-api/src/rls-proof.ts`

**Step-by-step tasks**
1. Replace the `project` import with `chronoBranch`.
2. Repoint the probe seeding (~:55-72) and the two cross-tenant reads (~:170-171, :205).
   Match `chronoBranch`'s required columns — it will need more than `{ id, tenantId, name }`;
   read its schema first and supply real values, not placeholders that trip a constraint.
3. Keep the non-vacuity assertion intact (`.ai/rules/database.md`: the proof must report
   *"non-vacuous (both tenants hold rows)?"* and fail if false).

**Acceptance criteria**
- `RLS PROOF: PASS ✅`, with the non-vacuity line still true for both tenants.
- Temporarily break isolation (e.g. point a read at `adminDb`) and confirm the proof
  **fails** — a proof that passes either way is worthless, and this phase is the one place
  that can silently introduce that.
- No reference to `project` remains in the file.

**Verification:** `pnpm --filter @agora/chrono-api rls:proof` · `pnpm typecheck`

**Out of scope:** every other file. Land and verify this phase on its own.

**Execution start point:** read `apps/chrono-api/src/modules/branch/schema.ts` for the
column set before editing the proof.

---

## Phase 2 — Repoint the admin count provider

**Files to update:** `apps/chrono-api/src/app.ts` (:212-230, :884)

**Step-by-step tasks**
1. Rename `projectCountsByTenant` → `branchCountsByTenant`, reading `chronoBranch`.
2. Update the injection site (:884) and its explanatory comment.
3. Update the label wherever the web renders it (`/admin/usage`, `/admin/metrics`,
   `/admin/organizations/[id]`) so it reads "Branches", not "Projects".

**Acceptance criteria**
- `/admin/usage`, `/admin/metrics` and the org detail page show a per-tenant **branch**
  count; no screen shows a stale "Projects" label or an empty column.
- The foundation still does not import Chrono's schema — the injection seam is unchanged
  in shape.

**Verification:** `pnpm typecheck` · `pnpm build`

**Out of scope:** removing anything; this phase only repoints.

**Execution start point:** `apps/chrono-api/src/app.ts:212`.

---

## Phase 3 — Remove the web surface

**Files to update:** delete `app/dashboard/projects/page.tsx`; edit
`app/dashboard/layout.tsx` (nav :61, breadcrumb :95, and the now-dead `projectsEnabled`
plumbing :151-172), `app/dashboard/page.tsx` (Overview card), `app/page.tsx`,
`app/dashboard/settings/audit/page.tsx`.

**Step-by-step tasks**
1. Delete the page and the nav/breadcrumb entries.
2. **Remove the `projectsEnabled` module lookup entirely** — with no nav entry to filter
   it is dead code, and leaving it means an `/rpc/modules` fetch on every dashboard load
   for nothing.
3. Replace the Overview's project-count card with a Chrono metric (branches or active
   sessions) rather than leaving a gap in the grid.

**Acceptance criteria**
- No route, nav entry, breadcrumb or card references projects.
- `/dashboard/projects` returns the app's normal 404, not a blank render.
- No raw HTML chrome introduced by the Overview edit (`.ai/rules/component-first-ui.md`).

**Verification:** `pnpm typecheck` · `pnpm build`

**Out of scope:** API routes (Phase 4), e2e specs (Phase 5).

**Execution start point:** `apps/chrono-web/src/app/dashboard/layout.tsx:61`.

---

## Phase 4 — Remove the API surface

**Files to update:** `apps/chrono-api/src/routes/rpc.ts` (~533, ~826, ~845),
`apps/chrono-api/src/routes/api-v1.ts` (:49-90), `apps/chrono-api/src/seed.ts`

**Step-by-step tasks**
1. **Confirm the public-API answer first** (Open Question 1). Do not delete
   `/api/v1/projects` on assumption.
2. Remove the three `/rpc` handlers and the two `/api/v1` handlers.
3. Remove project seeding from `seed.ts`.
4. Note the `project.created`/`project.deleted` webhook event types disappear with the
   handlers — confirm no tenant endpoint subscribes (Open Question 2).

**Acceptance criteria**
- No `/rpc/projects` or `/api/v1/projects` route resolves.
- The `AppType`/`RpcType` chain still infers — the handler chain must stay unbroken
  (`.ai/rules/api.md`); removing links from the middle of a chained builder is the easy
  way to break the typed client silently.
- `pnpm --filter @agora/chrono-web build` still typechecks against the narrowed client.

**Verification:** `pnpm typecheck` · `pnpm build` · `pnpm --filter @agora/chrono-api test:e2e`

**Out of scope:** the table itself (Phase 5).

**Execution start point:** `apps/chrono-api/src/routes/api-v1.ts:49`.

---

## Phase 5 — Drop the table

**Files to update:** `apps/chrono-api/src/db/schema.ts` (table definition + `"Projects"`
in `APP_TENANT_TABLES`), plus a generated migration.

**Step-by-step tasks**
1. Remove the `project` table and its `APP_TENANT_TABLES` entry.
2. `pnpm --filter @agora/chrono-api db:generate --name drop_projects_example`
3. **Review the generated SQL before applying** — it is a `DROP TABLE`, the one
   irreversible step in this plan (`.ai/rules/database.md` requires reviewing generated
   SQL for destructive ops).
4. `pnpm --filter @agora/chrono-api db:migrate`

**Acceptance criteria**
- `RLS PROOF: PASS ✅` — still, on the Phase 1 probe.
- `"Projects"` appears nowhere in `apps/chrono-api/src`.
- The migration is additive-history (a new migration, never an edit to an old one).

**Verification:** `pnpm --filter @agora/chrono-api rls:proof` · `pnpm typecheck`

**Out of scope:** `apps/agora-api`'s own `project` — untouched, it is the scaffold example.

**Execution start point:** review the generated SQL, not the schema file.

---

## Phase 6 — Tests + the documented wart

**Files to update:** delete `e2e/tests/data-listing/projects-listing.spec.ts` and
`e2e/tests/public-api/v1-projects.spec.ts`; repoint `modules/module-toggle.spec.ts`,
`impersonation/impersonation-scope.spec.ts`, `platform-admin/{metrics,usage}.spec.ts`,
`branches/branches.spec.ts`, `reservations/reservations.spec.ts`; update
`apps/chrono-api/src/e2e/run.ts` (**81 references** — the largest single edit in this
plan) and `e2e/permissions.test.ts`; add a note to `apps/chrono-api/AGENTS.md`.

**Step-by-step tasks**
1. Repoint the specs that use `project` merely as a generic tenant resource to
   `chronoBranch`. Delete only the two whose *subject* is projects.
2. Work through `e2e/run.ts` — budget real time; 81 references is not a find-and-replace,
   since some assert project-specific permission behaviour.
3. `permissions.test.ts` is a **drift guard**: it must still pass with `project` present
   in the foundation vocabulary but unused by Chrono. Adjust its expectations rather than
   deleting the assertion.
4. Document in `apps/chrono-api/AGENTS.md`: Chrono deliberately does not use the
   foundation's `project` resource; the permission and module entry remain in
   `packages/agora` for the scaffold, so `project:create`/`project:delete` are the one
   documented exception to `.ai/rules/rbac.md`'s "every action maps to a real gate".

**Acceptance criteria**
- `pnpm --filter @agora/chrono-api test:e2e` passes (the enforced gate).
- `pnpm --filter @agora/chrono-api test:permissions` passes.
- The AGENTS.md note exists, so the next auditor does not file the orphaned permission
  as a bug.

**Verification:** `pnpm --filter @agora/chrono-api test:e2e` ·
`pnpm --filter @agora/chrono-api test:permissions` · `pnpm typecheck` · `pnpm build`

**Out of scope:** changing `packages/agora`.

**Execution start point:** `apps/chrono-api/src/e2e/run.ts` — scope the work by reading
all 81 references before editing any.

---

## Out of Scope

- **Any edit to `packages/agora`.** The `project` permission, module-registry entry, and
  the scaffold's own table stay exactly as they are.
- `apps/agora-api` / `apps/agora-web` — the reference scaffold keeps `project` as its
  worked example, which is its whole purpose.
- Replacing `project` with a new generic Chrono resource. Chrono has 19 real modules; it
  needs no example resource.

---

## Open Questions (developer to confirm — both BLOCK Phase 4)

1. **Does anything consume `GET`/`POST /api/v1/projects`?** It is a public, versioned,
   API-key-authenticated surface. If a key holder uses it, removal is a breaking change
   needing a deprecation window, not a delete. I cannot determine this from the codebase —
   it depends on who holds keys.
2. **Does any tenant webhook endpoint subscribe to `project.created` / `project.deleted`?**
   Those event types vanish with the handlers. Checkable in
   `webhook_endpoint`, but it is a live-data question, not a code one.
3. **Is the stopgap enough for now?** If the only goal is that the customer stops seeing
   the menu entry, disabling the `project` module achieves it today with zero risk, and
   this plan can wait for a quieter moment. Phases 1–2 are worth doing regardless — they
   remove a scaffold dependency from the isolation proof, which is a latent trap
   independent of whether `project` is ever deleted.
