# Modules

Empty on purpose — no Chrono business domain has been planned yet.

One folder per business domain, e.g. `modules/branch/`, `modules/wallet/`. Each holds
that domain's `schema.ts` (Drizzle tables, tenantId + tenant index), `contracts.ts` (Zod
schemas), `routes.ts` (Hono factory typed on `TenantVars`), and any module-local tests.
`db/schema.ts` composes every module's schema; `routes/rpc.ts` composes every module's
`routes()`.

Full convention: `.ai/rules/business-app.md`. Per-resource steps (table → RLS →
contracts → routes → e2e): `.ai/rules/modules.md`, "Adding a Tenant-Scoped Resource."

Delete this file once the first module lands.
