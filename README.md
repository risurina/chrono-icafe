# Chrono

**Chrono** is a gaming/internet-café venue-management SaaS: branches (venue locations)
run stations (PC gaming seats) with paired kiosk devices; customers hold a wallet/credit
balance and run timed sessions on a station; staff work shifts. Loyalty, vouchers,
promos, POS, reservations, reporting/reconciliation, security alerts, QR flows, and
inquiries sit on top of that spine.

It's built on **Agora**, a multi-tenant SaaS foundation (auth, RBAC, custom domains,
Postgres row-level-security isolation) consumed here as a **git submodule** — see
"Foundation submodule" below.

Each tenant is a self-contained site on its own subdomain or custom domain:

```
acme.APP_DOMAIN/               public tenant landing
acme.APP_DOMAIN/login          staff/admin sign in  → /dashboard (back-office)
acme.APP_DOMAIN/portal/login   customer sign in     → /portal   (member area)
```

Two **separate** account pools per tenant: **staff** (Better Auth org; roles
owner/admin/staff) and **customers** (`tenant_member`, its own session) — a
customer can never reach the back-office.

## Stack

| Concern          | Choice                                                    |
| ---------------- | --------------------------------------------------------- |
| Monorepo         | pnpm workspaces + Turborepo                               |
| Web              | Next.js 15 (App Router) — `apps/chrono-web`                     |
| API              | Hono on a long-lived Node server — `apps/chrono-api`            |
| DB / ORM         | Neon Postgres + Drizzle — owned by `apps/chrono-api`       |
| Auth             | Better Auth (Organization plugin) — via the Agora foundation |
| Isolation        | shared DB + `tenant_id` + **forced RLS**                  |
| Tenant routing   | subdomains (`acme.APP_DOMAIN`) **and** custom domains     |
| Docs             | `apps/chrono-docs`                                         |

## Workspace layout

```
apps/chrono-api   Hono API — owns Chrono's own schema + routes; imports agora/*
apps/chrono-web   Next.js App Router UI (dashboard + portal + apex marketing)
apps/chrono-docs  Product documentation

packages/agora    git submodule — the entire risurina/agora monorepo, pinned to a
                   tagged release. The importable `agora` package (with its
                   `exports` map) lives one level deeper, at
                   packages/agora/packages/agora/.
```

`apps/chrono-api` groups its business domains under `src/modules/<domain>/` — one
folder per domain (`branch`, `station`, `member`, `wallet`, `session`, …), each with its
own schema, contracts, and routes, composed into `src/db/schema.ts` /
`src/routes/rpc.ts`. See `AGENTS.md` and `apps/chrono-api/AGENTS.md` for the full
product/domain context, module-by-module status, and every rule this repo follows.

## Foundation submodule

`packages/agora/` is the **entire** `risurina/agora` repo checked out at a pinned tag —
its own nested `packages/agora/` (the real importable package), its own reference
scaffold (`apps/agora-api`/`apps/agora-web`), its own `.ai/rules/`, and its own root
`AGENTS.md`. Do not edit anything under `packages/agora/` from this repo — it is a
separate repository, updated by bumping the submodule's pinned tag, not by hand-editing
files in place. See the root `AGENTS.md`, "Foundation submodule", before touching any
workspace/tooling config that interacts with it.

```bash
git submodule update --init --recursive   # after cloning, or if packages/agora is empty
```

## How multi-tenancy works

1. **Resolve** — no Next.js middleware. Server components call `agora/next`'s
   `getRequestTenant()`, which reads the incoming `host` header and runs the pure
   `parseHost()` to map it to a tenant: subdomain → slug, apex → marketing/auth,
   anything else → custom domain. In the browser, the RPC client derives
   `x-tenant-slug` / `x-tenant-host` from `window.location.host` on every API call.
   Authorization is enforced server-side in the API, not at this layer.
2. **Authorize** — `agora/server`'s `tenantMiddleware()` binds *session → host →
   membership → role*. A tenant only counts if the signed-in user is a `member`
   of it; the membership row is also where the role comes from.
   (`organization` = tenant.)
3. **Isolate** — tenant-scoped queries (both Agora's foundation tables and Chrono's
   own `Chrono*`-prefixed tables) run through `withTenant(tenantId, tx => …)`
   (`agora/db`), which sets `app.tenant_id` for the transaction. Postgres RLS
   (`ENABLE` + **`FORCE`**) then filters every row — isolation holds even if a
   query forgets `where tenant_id`, and even for the table owner.

   **Single database.** You only need one `DATABASE_URL`. The few framework reads
   that legitimately cross tenants or run before a tenant is known (resolving a
   custom domain → tenant, seeding) use an explicit `withAdmin(tx => …)`. Everything
   else stays fail-closed: no `withTenant` → zero rows, never another tenant's. Set
   the optional `DATABASE_URL_ADMIN` only if you want a physically separate
   admin/migration connection.

## Getting started

### 1. Prerequisites

- Node ≥ 20, pnpm 11
- A [Neon](https://neon.tech) Postgres database (free tier is fine)
- Git submodules initialized (`git submodule update --init --recursive`)

### 2. Configure

Each app has its own env file (there is no root `.env`):

```bash
cp apps/chrono-api/.env.example apps/chrono-api/.env
cp apps/chrono-web/.env.example apps/chrono-web/.env
```

Fill in `apps/chrono-api/.env`:

- `DATABASE_URL` — Neon **pooled** connection string, connecting as a restricted
  `NOBYPASSRLS` role (provision one with `pnpm db:app-role`, see
  `.ai/rules/database.md` via `packages/agora/.ai/rules/database.md`).
- `DATABASE_URL_ADMIN` — the owner/migration connection.
- `BETTER_AUTH_SECRET` — `openssl rand -base64 32`.
- `SSO_ENC_KEY` — `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
- `APP_DOMAIN` / `BETTER_AUTH_URL` — leave the `localtest.me` defaults for local
  dev (`*.localtest.me` resolves to 127.0.0.1, so `acme.localtest.me` and
  `api.localtest.me` work with no hosts-file editing).

Every other optional var (billing, webhooks, storage/Cloudinary, social sign-in,
notifications, …) is documented inline in `apps/chrono-api/.env.example` — add it only
once that feature is actually enabled.

`apps/chrono-web/.env` just needs `NEXT_PUBLIC_APP_DOMAIN` and `NEXT_PUBLIC_API_URL`
(defaults already point at the local setup). The DB scripts read `apps/chrono-api/.env`.

### 3. Install + set up the database

```bash
pnpm install
pnpm db:migrate    # apply generated migrations + FORCE RLS
pnpm db:seed       # demo tenants (acme, contoso, globex, …)
```

### 4. Run

```bash
pnpm dev           # web on :3000, api on api.localtest.me:8787
```

Open a tenant (each is a self-contained site):

- `http://acme.localtest.me:3000/` — Acme landing (staff + customer sign-in)
- `http://contoso.localtest.me:3000/` — Contoso landing
- `http://localtest.me:3000/` — apex marketing / workspace creation

Demo logins (from the seed, password `Password123!` unless noted):

| Tenant  | Staff (→ /dashboard) | Customer (→ /portal) |
| ------- | --------------------- | --------------------- |
| acme    | `owner@acme.test`     | `member@acme.test`    |
| contoso | `owner@contoso.test`  | `member@contoso.test` |
| globex  | `owner@globex.test`   | `member@globex.test`  |

## Verifying it works

```bash
# Full end-to-end test — ONE command. Resets the test DB, migrates, seeds, starts
# the REAL API, and drives the whole HTTP surface: public tenant, staff auth + RPC
# + role gating, customer auth, and cross-tenant isolation (RLS).
pnpm test:e2e
```

Two modes, same command:

- **No `TEST_DATABASE_URL`** → runs against an **in-process Postgres** (PGlite).
  Zero setup, offline/CI-friendly.
- **`TEST_DATABASE_URL` set** → runs against that **real Postgres**: it **DROPS
  ALL TABLES**, migrates, seeds, then tests. Point it at a **dedicated test
  database** (a separate Neon branch is ideal). Guarded — it refuses if the URL
  equals `DATABASE_URL` or the DB name doesn't contain `test` (override with
  `E2E_ALLOW_DESTRUCTIVE=1`).

```bash
# Isolation-only proof against an already-seeded real DB:
pnpm db:rls:proof
#  → "RLS PROOF: PASS ✅" — tenant A never sees tenant B's rows.
```

**CI:** `.github/workflows/ci.yml` runs on every PR and push to `main` — typecheck,
build, and `pnpm test:e2e` against a throwaway Postgres 16 service. CI connects as a
provisioned **non-superuser** role, so RLS is genuinely enforced (superusers bypass
RLS), matching a real Neon deployment.

Also try, by hand:

- `acme.localtest.me:3000/` → **staff** sign in as `owner@acme.test` → `/dashboard`;
  a `staff`-role user is blocked from admin-only actions while `admin`/`owner` succeed.
- `acme.localtest.me:3000/portal/login` → **customer** sign in as `member@acme.test`
  → `/portal`. Visiting `/dashboard` as a customer is rejected (separate pool).
- A customer of `acme` cannot sign in on `contoso.localtest.me` — customer
  accounts are scoped per tenant.
- Sign up at the apex → creates a new tenant (you're the `owner`).

## Deploying

The API holds a long-lived Node process, so the two apps deploy to different targets:

- **`apps/chrono-web` → Vercel.** Add a wildcard domain so every tenant subdomain
  resolves. Custom domains are added per tenant in Vercel + the app.
- **`apps/chrono-api` → Render** (see `render.yaml` below), or any always-on Node
  host. Point `BETTER_AUTH_URL` and `NEXT_PUBLIC_API_URL` at it, and list the web
  origins in `WEB_ORIGIN` for CORS.

Run migrations with `pnpm db:migrate` (applies generated migrations + RLS) against your
production `DATABASE_URL_ADMIN`.

**Deploying `apps/chrono-api` to Render:** a `render.yaml` Blueprint lives at the repo
root. In the Render dashboard, **New +** → **Blueprint** → point it at this GitHub repo
(enable "Include submodules" so `packages/agora` checks out), or `render login` then
create the service from the blueprint via the CLI. Fill in the `sync: false` env vars
(database, auth secret, domains) in the service's Environment tab — every other optional
var (billing, webhooks, storage/Cloudinary, social sign-in, …) is documented in
`apps/chrono-api/.env.example`; add it there only once that feature is enabled.

## Documentation

- `AGENTS.md` (+ `CLAUDE.md`, which points to it) — agent/developer context for this
  repo: workspace layout, the foundation submodule, and where every rule lives.
- `apps/chrono-api/AGENTS.md` — Chrono's product/domain context, module status, and
  business-app-specific rules (the single doc for the `chrono-api` + `chrono-web` pair).
- `apps/chrono-docs` — product documentation.
- `packages/agora/.ai/rules/*` (inside the submodule) — the foundation rules every
  module in this repo follows: tenant isolation, RBAC, DTO/contracts, component-first
  UI, e2e coverage, and more.

## Scripts

| Command              | What it does                                          |
| -------------------- | ------------------------------------------------------ |
| `pnpm dev`           | Run web + api                                          |
| `pnpm build`         | Build everything (Turbo)                               |
| `pnpm lint`          | Lint all packages                                      |
| `pnpm typecheck`     | Typecheck all packages                                 |
| `pnpm format`        | Prettier — write                                       |
| `pnpm db:migrate`    | Run SQL migrations + apply RLS                         |
| `pnpm db:push`       | Push schema to Neon + apply RLS (dev only)              |
| `pnpm db:studio`     | Drizzle Studio                                          |
| `pnpm db:seed`       | Seed demo tenants                                       |
| `pnpm db:generate`   | Generate a migration from schema changes                |
| `pnpm db:app-role`   | Provision the restricted `NOBYPASSRLS` app role         |
| `pnpm db:rls:proof`  | Prove tenant isolation against a seeded real DB         |
| `pnpm test:e2e`      | Full end-to-end suite (PGlite or real Postgres)         |
