/**
 * Terminal-status public-host filter test
 * (`.ai/plans/agora/active/public-host-status-filter/README.md` Phase 2).
 *
 * Proves `resolveOrgFromRequest` (`packages/agora/src/server/host.ts`) refuses
 * a tenant in a terminal lifecycle status by default — so every public route's
 * existing "org is null → 404" path now covers it — and that the explicit
 * `{ allowTerminalStatus: true }` opt-out still resolves, which is what keeps
 * an OWNER able to sign in to a suspended business and resume it.
 *
 * Lives under chrono-api (not packages/agora) because the foundation package
 * has no test harness of its own; this exercises the foundation helper through
 * a real Postgres connection, which is where the behavior actually matters.
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database). Skips
 * gracefully with a clear message when it isn't set.
 */
import "dotenv/config";
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
      const cols = (i.config.columns as { name: string }[])
        .map((c) => `"${c.name}"`)
        .join(", ");
      return `create unique index if not exists "${i.config.name}" on "${cfg.name}" (${cols});`;
    });
}

let passed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(name + (detail ? ` — ${detail}` : ""));
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function die(msg: string): never {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
}

async function main() {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) {
    console.log(
      "\nhost-status-filter test skipped: TEST_DATABASE_URL is not set.\n" +
        "  Set TEST_DATABASE_URL to a dedicated *test*-named database to run it.\n",
    );
    process.exit(0);
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === testUrl) {
    die("TEST_DATABASE_URL must differ from DATABASE_URL — refusing to drop your main DB.");
  }
  let dbName = "";
  try {
    dbName = new URL(testUrl).pathname.replace(/^\//, "");
  } catch {
    die("TEST_DATABASE_URL is not a valid connection URL.");
  }
  if (!/test/i.test(dbName) && process.env.E2E_ALLOW_DESTRUCTIVE !== "1") {
    die(
      `Refusing to drop tables on database "${dbName}" — its name doesn't contain "test".\n` +
        `  Point TEST_DATABASE_URL at a dedicated test database, or set E2E_ALLOW_DESTRUCTIVE=1 to override.`,
    );
  }

  const url = new URL(testUrl);
  url.hostname = url.hostname.replace("-pooler", "");
  process.env.DATABASE_URL = url.toString();

  const adminEnvUrl = process.env.DATABASE_URL_ADMIN;
  if (!adminEnvUrl) {
    die("DATABASE_URL_ADMIN is not set — needed to run schema setup against the test database.");
  }
  const admin = new URL(adminEnvUrl);
  const adminForTest = new URL(url.toString());
  adminForTest.username = admin.username;
  adminForTest.password = admin.password;
  process.env.DATABASE_URL_ADMIN = adminForTest.toString();
  console.log(`\nhost-status-filter test mode: REAL database "${dbName}"`);

  process.env.APP_DOMAIN = "localtest.me:3000";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
  process.env.WEB_ORIGIN = "http://localtest.me:3000";
  process.env.NODE_ENV = "test";
  process.env.DOMAIN_PROVIDER = "noop";
  process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
  process.env.STORAGE_PROVIDER = "local";

  const { registerChronoPermissions } = await import("../../auth/permissions");
  registerChronoPermissions();

  const { adminDb, adminPool, pool, schema, applyRls, BASE_TENANT_TABLES } =
    await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { createId } = await import("agora");
  const { resolveOrgFromRequest, TERMINAL_TENANT_STATUSES } = await import("agora/server");
  const { Hono } = await import("hono");

  const appSchema = await import("../../db/schema");
  const tables = Object.values(appSchema).filter((v) => is(v, PgTable)) as PgTable[];

  console.log("  dropping all tables…");
  await adminPool.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_e2e') THEN
      EXECUTE 'DROP OWNED BY app_e2e CASCADE';
    END IF;
  END $$;`);
  for (const t of tables) {
    await adminPool.query(`DROP TABLE IF EXISTS "${getTableConfig(t).name}" CASCADE;`);
  }
  console.log("  running migration (schema push)…");
  for (const t of tables) await adminPool.query(tableDdl(t));
  for (const t of tables) for (const ddl of uniqueIndexDdls(t)) await adminPool.query(ddl);
  await adminPool.query(`GRANT USAGE ON SCHEMA public TO chrono_app;`);
  await adminPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chrono_app;`);
  await applyRls(adminPool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  console.log("  seeding one org per lifecycle status…");
  const liveStatuses = ["active", "trial", "pending"] as const;
  const slugs = new Map<string, string>();
  for (const status of [...liveStatuses, ...TERMINAL_TENANT_STATUSES]) {
    const slug = `status-${status}`;
    slugs.set(status, slug);
    await adminDb.insert(schema.organization).values({
      id: createId(),
      slug,
      name: `Org ${status}`,
      status,
    });
  }

  // Drive the real helper through a real Hono context carrying the same
  // x-tenant-slug header the browser client sends.
  type ResolvedOrg = { slug: string; status: string | null };
  async function resolve(
    slug: string,
    opts?: { allowTerminalStatus?: boolean },
  ): Promise<ResolvedOrg | null> {
    const probe = new Hono();
    let resolved: ResolvedOrg | null = null;
    probe.get("/probe", async (c) => {
      const org = await resolveOrgFromRequest(c, opts);
      resolved = org ? { slug: org.slug, status: org.status } : null;
      return c.json({ ok: true });
    });
    await probe.fetch(
      new Request("http://localhost/probe", { headers: { "x-tenant-slug": slug } }),
    );
    return resolved;
  }

  console.log("\nLive statuses must still resolve (no behavior change):\n");
  for (const status of liveStatuses) {
    const got = await resolve(slugs.get(status)!);
    check(`status "${status}" still resolves`, got?.status === status, `got = ${JSON.stringify(got)}`);
  }

  console.log("\nTerminal statuses must resolve to null by default:\n");
  for (const status of TERMINAL_TENANT_STATUSES) {
    const got = await resolve(slugs.get(status)!);
    check(`status "${status}" resolves to null (public routes 404)`, got === null, `got = ${JSON.stringify(got)}`);
  }

  console.log("\nThe explicit opt-out must still resolve them (owner recovery path):\n");
  for (const status of TERMINAL_TENANT_STATUSES) {
    const got = await resolve(slugs.get(status)!, { allowTerminalStatus: true });
    check(
      `status "${status}" resolves with allowTerminalStatus: true`,
      got?.status === status,
      `got = ${JSON.stringify(got)}`,
    );
  }

  console.log("\nAn unknown host still resolves to null, unchanged:\n");
  check("unknown slug resolves to null", (await resolve("no-such-tenant")) === null);
  check(
    "unknown slug resolves to null even with the opt-out",
    (await resolve("no-such-tenant", { allowTerminalStatus: true })) === null,
  );

  await pool.end?.();
  await adminPool.end?.();

  console.log(`\n${passed} passed, ${failures.length} failed.\n`);
  if (failures.length > 0) {
    console.error("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
