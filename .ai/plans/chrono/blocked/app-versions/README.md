# Chrono — `app-versions` module

**Blocked on:** no PC-client app exists in this workspace (`apps/chrono-pc-client` is
explicitly out of scope for this migration pass) and no device-pairing/bearer-auth
mechanism has landed yet (`devices` module: contracts only, no schema/routes). This plan
is filed to `.ai/plans/chrono/blocked/` per `.ai/rules/feature-planning.md`'s
"blocked on an external dependency" category — not deferred by choice, blocked by fact.

## What this is (deferred scope)

A release-registry for the PC-client app: record each build's `{platform, version, url,
channel, releaseNotes, isMandatory, status}`, let a platform operator promote a version
through `draft → pilot → production`, and let a paired device report its own
`clientVersion` so staleness/mandatory-update prompts can be driven server-side. This is
the feature `apps/chrono-api/AGENTS.md` gestures at when it says the API "still needs to
support device pairing/bearer-auth for it eventually" — quoted verbatim below.

---

## Pass 1 — Workflow Analysis (of the eventual feature, not of what's buildable now)

**Who uses it:** a platform/ops operator (not a tenant member — this is cross-tenant,
one release feed shared by every tenant's paired devices) publishes/promotes versions; a
paired PC-client device reads the current channel's version on boot/heartbeat to decide
whether to prompt/force an update.

**Workflow:** operator creates a draft version row, attaches a release URL and notes,
promotes it to `pilot` then `production`; a device's heartbeat/status call compares its
own `clientVersion` against the active `production` (or `pilot`, if enrolled) version and
surfaces `updateRequired`/`updateAvailable` to the client UI.

**Failure cases:** a device reporting a version newer than any known row (dev build) must
not be treated as out-of-date; a `DELETE`/archive of the version currently marking a
device as "must update" must not orphan that check; unauthenticated device calls must be
rejected by whatever device-auth mechanism eventually exists — there is no session/tenant
host to resolve this through `tenantMiddleware()`, since a released binary is not a
tenant-scoped concept at all (it is platform-global, shared across every tenant's
devices).

**Audit / notifications:** version promotion should be audited on whichever admin surface
ends up owning it (see Pass 2 — this looks like a platform-admin resource, not a tenant
`/rpc` one).

---

## Pass 2 — Technical Planning: why this is BLOCKED, not just deferred

### Verbatim source of the "eventually" language

`apps/chrono-api/AGENTS.md` states:

> **Out of scope for this pass** — `apps/chrono-mobile`, `apps/chrono-pc-client` (+
> `-service`, `-tauri`), `apps/chrono-docs` from the source implementation. This pass is
> `apps/chrono-api` + `apps/chrono-web` only; the API still needs to support device
> pairing/bearer-auth (stations depend on it) even though the PC-client apps themselves
> aren't being ported yet.

And separately, in the same file's Modules section:

> **Deferred (later waves, not in this pass)** — `loyalty`, `vouchers`, `promos`, `pos`,
> `reservations`, `reports`, `reconciliation`, `security-alerts`, `qr`, `inquiries`,
> `onboarding-checklist`, `app-versions`, `app-usage`, `public-stations`,
> `public-releases`, `tenant-landing`, `admin-station-client`. Present in the source
> implementation; not planned until Wave 1 is proven.

(Note: this AGENTS.md file is stale relative to `.ai/handover/chrono-migration.md` — it
still lists `pos` and `reservations` as deferred though both have since been planned and,
for `reservations`, fully implemented. `app-versions`/`app-usage`/`onboarding-checklist`
remain genuinely un-started in both documents, so the staleness does not change this
plan's conclusion.)

### Prior-art shape (oikos, reference only — confirms the coupling, not a spec to copy)

`apps/chrono-api/src/database/schema/app-version.ts` in the pre-Agora implementation
defines an `AppVersion` table (`platform`/`version`/`url`/`channel`/`releaseNotes`/
`isMandatory`/`status`) with unique `(platform, version)`, and
`apps/chrono-api/src/modules/app-versions/routes.ts` gates every route behind
`requireRole(['SUPER_ADMIN', 'TECH_ADMIN', ...])` — i.e. a **platform-operator** role
check, not a tenant `member`/`admin`/`owner` check. In oikos's own architecture this was
never a per-tenant resource; it was a cross-tenant release feed consumed by devices
belonging to any tenant.

### Why this cannot be planned as a normal tenant-scoped module right now

Mapping this feature onto Agora's actual primitives surfaces three unresolved
dependencies, each itself unbuilt:

1. **It isn't tenant-scoped, so it isn't a `/rpc` Chrono module in the `project`/
   `branch`/`station` sense.** A release is shared across every tenant's devices — the
   natural home is a **platform-admin** surface (`/admin/*` + `/rpc-admin/*`, its own
   `PLATFORM_PERMISSION_STATEMENTS` resource), exactly like `platform_integration` or the
   subscription-plan catalog. Planning it as a Chrono `src/modules/<domain>/` tenant
   table (per `.ai/rules/business-app.md`) would be the wrong shape entirely and would
   have to be re-planned once the true audience is confirmed. Whether Chrono ever gets
   its *own* platform-admin extension surface (as opposed to reusing Agora's existing
   one) is itself an open architectural question this repo hasn't answered for any
   business app yet.
2. **There is no device identity to attach a version report to.** The `devices` module
   (`apps/chrono-api/src/modules/device/`) has landed contracts only — no `schema.ts`,
   no `routes.ts`, no bearer-auth middleware. `app-versions`' one *consuming* workflow
   (a device checking its own version against the feed) has literally nothing to call
   from yet.
3. **There is no PC-client binary to version.** `apps/chrono-pc-client` does not exist in
   this workspace and is explicitly out of scope for the whole migration pass per
   `AGENTS.md`. A version registry with zero producers and zero real consumers is pure
   speculative infrastructure — exactly the kind of premature abstraction
   `.ai/rules/ai-agent.md` and `feature-planning.md`'s Planner Mindset both warn against
   ("do not create business-specific modules unless requested," "reuse the nearest
   existing pattern," building `for now` scaffolding is explicitly discouraged
   elsewhere in these rules for the same reason: `.ai/rules/architecture.md`'s Business
   Apps section — "Never build a generic capability directly inside a business app 'for
   now'").

A minimal backend-only stub (just the table + a couple of admin CRUD routes with no real
consumer) was considered and rejected: it would need to guess the eventual permission
resource, the eventual device-auth shape, and the eventual admin surface (Chrono's own
vs. reusing Agora's platform-admin) — three guesses that `devices` Phase 1 will answer
authoritatively once it lands. Building ahead of that would very likely need a rewrite,
not a refinement, the moment `devices` actually ships its bearer-auth design (which the
migration handover itself flags as "genuinely novel — review before Phase 3, not a
rubber-stamp open question").

### Unblocking condition

Re-open this plan (move `.ai/plans/chrono/blocked/app-versions/` → `.ai/plans/chrono/
draft/app-versions/`) once **both** of the following are true:
1. `devices` module Phase 1 (schema) has landed, so a real device identity/bearer-auth
   shape exists to design the consuming side against, and
2. a decision has been made — by the developer, not inferred by an agent — on whether
   `apps/chrono-pc-client` will actually be built in this workspace, or whether
   `app-versions` should instead be scoped down to "a platform-admin release feed with no
   real consumer yet" as a deliberate, explicitly-accepted speculative build.

---

## Out of Scope (this plan, as filed)

Everything — this document exists to record the blocking analysis, not to propose
phases. No schema, contracts, routes, or UI are specified here because doing so before
the two unblocking conditions above would guess at shapes (permission resource, device
auth integration, admin-vs-tenant surface) that are not yet knowable.

---

## Open Questions (developer to confirm/override)

1. Is `apps/chrono-pc-client` actually planned to be built in this workspace at all, or
   is the PC-client a permanently external/legacy artifact this Agora migration will
   never host? This single answer determines whether `app-versions` is worth planning
   ahead of `devices`, or should be re-filed as `future/` instead of `blocked/` (per
   `.ai/rules/feature-planning.md`'s distinction: `blocked/` = blocked on fact, `future/`
   = deferred by choice) once the true reason becomes "we don't want this yet" rather
   than "we can't design this yet."
2. If/when this becomes buildable, should it live under Chrono's own module tree
   (`apps/chrono-api/src/modules/app-version/`) with a Chrono-only platform-admin
   extension surface, or should platform-wide app-release management become a genuinely
   foundation-generic primitive in `packages/agora` (since any future business app with
   a native client would need the identical shape)? Flag for a fresh Pass 2 once
   `devices` ships.

---

## After Implementation

Not applicable — this plan is not implementation-ready. When the unblocking conditions
are met, write a fresh Pass 1/Pass 2/phased plan (this document may be used as a
starting reference for the workflow analysis, but its Pass 2 must be redone against the
real `devices` schema once it exists) and file it under
`.ai/plans/chrono/draft/app-versions/README.md`, then update
`.ai/handover/chrono-migration.md`'s deferred-modules table accordingly.
