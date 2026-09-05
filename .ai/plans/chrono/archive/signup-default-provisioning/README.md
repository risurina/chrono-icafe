# Auto-provision "Main" branch + default station groups on tenant signup

Status: Approved — implementing.
App: chrono (`apps/chrono-web` only — no `apps/chrono-api` or schema changes)

## Context

Today, a brand-new Chrono tenant signs up and lands on an empty `/admin` dashboard with
zero branches and zero station groups — the owner must manually walk the Setup wizard
(`dashboard/setup/page.tsx`) to create a branch, then a station group, one field at a
time. The developer wants every new tenant to start with a working floor instead: a
default **"Main"** branch, and three station groups with fixed default rates:

| Group | Hourly rate | Member rate |
|---|---|---|
| Regular | ₱30 | ₱20 |
| Premium | ₱40 | ₱30 |
| VIP | ₱50 | ₱40 |

No new schema, table, column, or `/rpc` route is needed — `POST /rpc/branches` and
`POST /rpc/stations/groups` (`apps/chrono-api/src/modules/branch/routes.ts:88-131`,
`apps/chrono-api/src/modules/station/routes.ts:519-561`) already do exactly this insert,
gated by `branch:["create"]` (owner/admin only) and `station:["create"]` (staff+admin+
owner) respectively — a freshly-signed-up user is the new org's **owner**, so both gates
pass with no permission changes. `apps/chrono-api/src/seed.ts:248-273`'s dev-seed data
(`"main"` branch, `"regular"`/`"premium"`/`"vip"` groups) is the nearest existing
precedent for the exact shape, just with different rates.

## Architecture decision: trigger from the dashboard's first load, not from the sign-up page

Both `apps/chrono-web/src/app/(saas-landing)/sign-up/page.tsx:67-79` and
`.../new-business/page.tsx:79-91` call `authClient.organization.create(...)` **while the
browser is still on the apex host**, then `location.href` to
`{slug}.APP_DOMAIN/admin`. The typed API client (`apps/chrono-web/src/lib/rpc.ts`) sends
tenant headers derived from `window.location.host` (`tenantFetch()`, per
`.ai/rules/architecture.md`'s "Next.js Request Boundary" — no middleware, tenant is
resolved from the host on every request). Calling `POST /rpc/branches` right after
`organization.create()` — still on the apex — would 401/404 because there is no tenant
context on that host yet.

So provisioning must run **after** the redirect, once the browser is actually on
`{slug}.APP_DOMAIN`. The natural, single injection point is
`apps/chrono-web/src/app/(tenant-admin)/dashboard/page.tsx` — the physical file `/admin`
rewrites onto (`apps/chrono-api/AGENTS.md` "Surfaces"), i.e. the very first page a
freshly-redirected owner lands on, regardless of whether they came from `/sign-up` or
`/new-business`. This means **neither sign-up page needs to change at all** — one hook
point covers every path that creates an organization today (and any that's added later).

The page already fetches `api.rpc.me.$get()` on mount (`dashboard/page.tsx:31-36`),
which both confirms real tenant/session context and returns `{ tenantSlug, role }`. Gate
provisioning on `role === "owner" || role === "admin"` (avoids a pointless 403 for a
`staff` member who happens to load an empty-branch tenant) and on **zero existing
branches** (`GET /rpc/branches?pageSize=1`'s `meta.totalItems === 0`, same probe
`useFirstBranch()` in `.../onboarding/steps/types.ts:17-32` already uses) — so this only
ever fires once per tenant, is safe on every subsequent page load, and needs no query-param
flag or extra state.

**Idempotency / race safety:** if two tabs both race the zero-branch check, the loser's
`POST /branches` 409s (`branch/routes.ts:118-121`, unique on `(tenantId, code)`) —
re-fetch branches and use the winner's id to continue creating groups. A losing group
`POST` 409s per-group (unique on `(branchId, code)`) and is simply ignored — nothing
downstream needs the created group's id. No visible error for either race case; a plain
network/server error (non-409) fails silently too — this is background plumbing, not a
user-initiated action, and the owner can still complete the exact same setup manually via
the existing wizard if it doesn't fire.

## Files to change

**New:** `apps/chrono-web/src/lib/onboarding-defaults.ts`

```ts
import { api } from "@/lib/rpc";
import { toast } from "agora/ui";

const DEFAULT_STATION_GROUPS = [
  { name: "Regular", code: "regular", hourlyRate: 30, memberRate: 20 },
  { name: "Premium", code: "premium", hourlyRate: 40, memberRate: 30 },
  { name: "VIP", code: "vip", hourlyRate: 50, memberRate: 40 },
] as const;

/**
 * Seeds a brand-new tenant with a "Main" branch and Regular/Premium/VIP
 * station groups so a fresh sign-up starts with a working floor instead of
 * an empty dashboard. No-ops if a branch already exists.
 */
export async function provisionDefaultsIfNeeded(): Promise<void> {
  const existing = await api.rpc.branches.$get({ query: { pageSize: "1" } });
  if (!existing.ok || (await existing.json()).meta.totalItems > 0) return;

  const created = await api.rpc.branches.$post({ json: { name: "Main" } });
  let branchId: string | undefined;
  if (created.ok) {
    branchId = (await created.json()).branch?.id;
  } else if (created.status === 409) {
    const retry = await api.rpc.branches.$get({ query: { pageSize: "1" } });
    if (retry.ok) branchId = (await retry.json()).items[0]?.id;
  }
  if (!branchId) return;

  await Promise.all(
    DEFAULT_STATION_GROUPS.map((group) =>
      api.rpc.stations.groups.$post({ json: { branchId, ...group } }),
    ),
  );

  toast.success(
    'Set up a default "Main" branch with Regular, Premium, and VIP station groups — customize anytime from Setup.',
  );
}
```

`name: "Main"` with no `code` lets the server derive `"main"` itself
(`generateBranchCode()`, `branch/routes.ts:18-23`) instead of duplicating that slug logic
client-side. Station-group `code` is required by `createStationGroupSchema`
(`station/contracts.ts:16-23`), so it's passed explicitly.

**Edit:** `apps/chrono-web/src/app/(tenant-admin)/dashboard/page.tsx` — in the existing
mount effect (lines 29-49), after `setMe(...)`, fire-and-forget the new helper when the
role qualifies:

```ts
const meJson = (await meRes.json()) as Me;
setMe(meJson);
if (meJson.role === "owner" || meJson.role === "admin") {
  void provisionDefaultsIfNeeded();
}
```

(placed before the existing `Promise.all([...])` for project/member/billing/onboarding
counts — runs concurrently, doesn't block the rest of the page from loading.)

## Out of scope

- No change to `sign-up/page.tsx` or `new-business/page.tsx`.
- No change to the Setup wizard's manual `createBranch`/`addStationGroup` steps — they
  still work unmodified for a tenant where auto-provisioning didn't apply (e.g. a staff
  member's first load) or where the owner wants a different first branch.
- No new permission, no new `/rpc` route, no schema/migration, no `rls:proof` impact
  (zero schema/RLS change).
- No configurable defaults (rates are fixed at 30/20, 40/30, 50/40 today) — a future
  request to make these tenant/plan-configurable is separate follow-up work.

## E2E coverage

**New:** `apps/chrono-web/e2e/tests/branches/signup-default-provisioning.spec.ts`

Sign up a fresh tenant via the real `/sign-up` form (faker-generated business name/email,
per `.ai/rules/e2e-testing.md`), let it redirect to `/admin`, then assert via the typed
API (`GET /rpc/branches`, `GET /rpc/stations/groups?branchId=...`) that exactly one
branch named "Main" (code `main`) exists with three station groups named Regular/
Premium/VIP carrying hourlyRate `30.00`/`40.00`/`50.00` and memberRate `20.00`/`30.00`/
`40.00`. Asserting via the API rather than a specific dashboard tab's UI avoids coupling
this spec to the in-flight, uncommitted "Station Control" tab-rename work already
underway in `stations/page.tsx` (`.ai/plans/chrono/active/station-control-grouping/`) —
the trigger itself (real sign-up → real `/admin` navigation) still drives the actual
feature end-to-end, matching this module's existing precedent of verifying data
correctness via the typed client after a real UI-driven action.

No new role-gate or tenant-isolation case is added: no new permission or route is
introduced (the existing `branch:create`/`station:create` gates and `chronoBranch`/
`chronoStationGroup` RLS policies are already proven elsewhere), and each tenant only
ever provisions its own rows via its own owner session.

## Verification

- `pnpm typecheck`
- `npx playwright test e2e/tests/branches/signup-default-provisioning.spec.ts` (manual
  Playwright setup — `pnpm dev` running first, no `apps/chrono-api/.env` present)
- Manual: sign up a fresh tenant via the running app, confirm `/admin` → Stations page
  shows a "Main" branch and Regular/Premium/VIP groups with the correct rates.

## Plan Closure

Move this plan from `.ai/plans/chrono/active/` to `.ai/plans/chrono/archive/` once both
phases (implementation, e2e) pass.
