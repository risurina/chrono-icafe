/**
 * Regression test for the `inviteStaff` connection-nesting deadlock (Phase 0,
 * `.ai/plans/chrono/active/platform-admin-onboarding-progress/README.md`).
 *
 * Standalone tsx script (no unit-test runner in this repo), run under
 * `DB_DRIVER=pglite` — the driver mode where `adminDb === db`
 * (`packages/agora/src/core/db/client.ts`), the exact aliasing the real
 * hazard depends on. `apps/chrono-api/src/modules/onboarding/routes.test.ts`
 * cannot prove this instead: it requires `DATABASE_URL_ADMIN` pointed at a
 * DIFFERENT role than `DATABASE_URL`, which makes `adminDb`/`db` two SEPARATE
 * pools there, so the nesting hazard cannot reproduce in that file regardless
 * of pool-size tricks (and it silently `process.exit(0)`s when
 * `TEST_DATABASE_URL` is unset).
 *
 * Races `resolveOnboardingState(tenantId, userId, permissions)` against a
 * ~5s timeout. Before the Phase 0 fix, `inviteStaff`'s probe issues a second
 * `adminDb.select(...)` against the SAME pglite client while
 * `resolveOnboardingState`'s own `withTenant` transaction is still open —
 * PGlite's internal transaction mutex queues that second query behind the
 * open transaction, and the open transaction is itself awaiting that same
 * query's result (via `Promise.all` over every item's probe) — a genuine
 * deadlock, not a slow query, so the race only ever resolves via the
 * timeout. After the fix (the probe reads through its supplied `tx`
 * instead), the call resolves well within the timeout.
 *
 * Run once against the pre-fix probe (confirms the hang reproduces) and once
 * against the post-fix probe (confirms it now resolves) — see this phase's
 * commit message for both recorded results.
 */
process.env.DB_DRIVER = "pglite";
process.env.APP_DOMAIN = "localtest.me:3000";
process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
process.env.WEB_ORIGIN = "http://localtest.me:3000";
process.env.NODE_ENV = "test";
process.env.DOMAIN_PROVIDER = "noop";
process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
process.env.STORAGE_PROVIDER = "local";

import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

/** Emit CREATE TABLE from the Drizzle schema (no drizzle-kit needed at runtime). */
function tableDdl(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    let s = `"${c.name}" ${c.getSQLType()}`;
    if (c.primary) s += " primary key";
    if (c.notNull) s += " not null";
    if (c.default !== undefined) {
      const isSqlObject =
        typeof c.default === "object" &&
        c.default !== null &&
        "queryChunks" in (c.default as Record<string, unknown>);
      if (typeof c.default === "boolean" || typeof c.default === "number") {
        s += ` default ${c.default}`;
      } else if (typeof c.default === "string") {
        s += ` default '${c.default.replace(/'/g, "''")}'`;
      } else if (typeof c.default === "object" && c.default !== null && !isSqlObject) {
        s += ` default '${JSON.stringify(c.default).replace(/'/g, "''")}'::${c.getSQLType()}`;
      } else {
        s += " default now()";
      }
    }
    return s;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
function uniqueIndexDdls(table: PgTable): string[] {
  const cfg = getTableConfig(table);
  return cfg.indexes
    .filter((i) => i.config.unique)
    .map((i) => {
      const cols = (i.config.columns as { name: string }[]).map((c) => `"${c.name}"`).join(", ");
      return `create unique index if not exists "${i.config.name}" on "${cfg.name}" (${cols});`;
    });
}

const TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function main() {
  const { registerChronoPermissions } = await import("../../auth/permissions");
  registerChronoPermissions();

  const { adminDb, pool, schema } = (await import("agora/db")) as any;
  const { createId } = await import("agora");

  const appSchema = await import("../../db/schema");
  const tables = Object.values(appSchema).filter((v) => is(v, PgTable)) as PgTable[];

  console.log("  creating pglite schema…");
  for (const t of tables) await pool.query(tableDdl(t));
  for (const t of tables) for (const ddl of uniqueIndexDdls(t)) await pool.query(ddl);

  // Imported AFTER registerChronoPermissions() runs — resolveOnboardingState
  // pulls in agora/auth transitively (via ../../auth/require-permission),
  // which freezes the permission registry on first import.
  const { resolveOnboardingState } = await import("./service");

  const tenantId = createId();
  const userId = createId();

  await adminDb
    .insert(schema.organization)
    .values({ id: tenantId, slug: "probe-tx-test", name: "Probe Tx Test" });
  await adminDb.insert(schema.user).values({
    id: userId,
    email: "owner@probe-tx-test.test",
    name: "Probe Owner",
    emailVerified: true,
  });
  await adminDb.insert(schema.member).values({
    id: createId(),
    organizationId: tenantId,
    userId,
    role: "owner",
  });

  console.log("  racing resolveOnboardingState against a 5s timeout…");
  const start = Date.now();
  try {
    const state = await withTimeout(
      resolveOnboardingState(tenantId, userId, { organization: ["read"] }),
      TIMEOUT_MS,
    );
    console.log(
      `  ✅ resolveOnboardingState resolved in ${Date.now() - start}ms — ` +
        `${state.completedCount}/${state.total} complete, no deadlock`,
    );
    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("timed out")) {
      console.log(
        `  ❌ resolveOnboardingState did not resolve within ${TIMEOUT_MS}ms — deadlock reproduced`,
      );
    } else {
      console.log(`  ❌ resolveOnboardingState rejected (not a hang): ${message}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
