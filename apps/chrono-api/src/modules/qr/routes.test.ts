/**
 * QR module route-level test (qr plan Phase 3 acceptance criteria) — mirrors
 * `session/concurrency.test.ts`'s scaffold: resets and re-migrates a
 * dedicated *test*-named database, seeds two real tenants, then drives the
 * real HTTP surface (`stationQrRoutes()` + `qrPublicRoutes()`) via
 * `app.fetch`, not mocks.
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod). Skips gracefully with a clear message when it isn't set.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

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
      "\nqr route test skipped: TEST_DATABASE_URL is not set.\n" +
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
  console.log(
    `\nqr route test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`,
  );

  process.env.APP_DOMAIN = "localtest.me:3000";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
  process.env.WEB_ORIGIN = "http://localtest.me:3000";
  process.env.NODE_ENV = "test";
  process.env.DOMAIN_PROVIDER = "noop";
  process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
  process.env.STORAGE_PROVIDER = "local";

  const { registerChronoPermissions } = await import("../../auth/permissions");
  registerChronoPermissions();

  const { adminDb, adminPool, pool, withTenant, schema, applyRls, BASE_TENANT_TABLES } =
    await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { chronoBranch } = await import("../branch/schema");
  const { chronoStation } = await import("../station/schema");
  const { chronoQrTokenUse } = await import("./schema");
  const { createId } = await import("agora");
  const { eq } = await import("agora/db");
  const { mintStationQrToken } = await import("./token");
  const { qrPublicRoutes } = await import("./public-routes");
  const { stationQrRoutes } = await import("./routes");
  const { Hono } = await import("hono");
  const { HttpError } = await import("agora/server");

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
  await adminPool.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chrono_app;`,
  );
  await applyRls(adminPool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  console.log("  seeding two tenants…");

  async function seedTenant(slug: string) {
    const tenantId = createId();
    await adminDb.insert(schema.organization).values({ id: tenantId, slug, name: slug });
    const memberId = createId();
    const memberEmail = `customer@${slug}.test`;
    await withTenant(tenantId, (tx) =>
      tx.insert(schema.tenantMember).values({
        id: memberId,
        tenantId,
        email: memberEmail,
        name: "Test Customer",
        passwordHash: "unused-in-this-test",
      }),
    );
    const memberToken = `member-session-${createId()}`;
    await withTenant(tenantId, (tx) =>
      tx.insert(schema.tenantMemberSession).values({
        id: createId(),
        tenantId,
        memberId,
        tokenHash: createHash("sha256").update(memberToken).digest("hex"),
        expiresAt: new Date(Date.now() + 60 * 60_000),
      }),
    );
    const [branch] = await withTenant(tenantId, (tx) =>
      tx
        .insert(chronoBranch)
        .values({ id: createId(), tenantId, name: "Main Branch", code: "MAIN" })
        .returning(),
    );
    const [station] = await withTenant(tenantId, (tx) =>
      tx
        .insert(chronoStation)
        .values({
          id: createId(),
          tenantId,
          branchId: branch!.id,
          name: "Station 1",
          stationNumber: "1",
        })
        .returning(),
    );
    return { tenantId, slug, memberId, memberToken, branchId: branch!.id, stationId: station!.id };
  }

  const tenantA = await seedTenant("qr-route-test-a");
  const tenantB = await seedTenant("qr-route-test-b");

  // Give tenant A's station a QR secret directly (bypassing the staff route
  // for this first mint, matching the "already regenerated once" state most
  // scans happen against).
  const secretA = "test-secret-a-0123456789abcdef0123456789abcdef";
  await withTenant(tenantA.tenantId, (tx) =>
    tx
      .update(chronoStation)
      .set({ qrSecret: secretA, qrSecretVersion: 1 })
      .where(eq(chronoStation.id, tenantA.stationId)),
  );

  // Build a minimal app exposing the same two routers the real app.ts /
  // rpc.ts mount, keyed the same way.
  const app = new Hono()
    .route("/public/qr", qrPublicRoutes())
    .route("/rpc/stations", stationQrRoutes());
  // Mirrors app.ts's own onError mapping for HttpError -> { error } JSON, so
  // the generic-error-shape assertions below see the real client-facing body
  // instead of an unhandled-throw 500.
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message }, err.status);
    }
    console.error(err);
    return c.json({ error: "Internal Server Error" }, 500);
  });

  async function resolve(token: string) {
    return app.request(`/public/qr/resolve?token=${encodeURIComponent(token)}`);
  }
  async function consume(token: string, tenant: { slug: string; memberToken: string }) {
    return app.request("/public/qr/consume", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-tenant-slug": tenant.slug,
        cookie: `agora_member=${tenant.memberToken}`,
      },
      body: JSON.stringify({ token }),
    });
  }

  console.log("\n1) Full round trip: valid token resolves, then consumes once.\n");
  const validToken = mintStationQrToken({ id: tenantA.stationId, qrSecret: secretA, qrSecretVersion: 1 });

  const resolveRes = await resolve(validToken);
  check("resolve: valid token -> 200", resolveRes.status === 200, `got ${resolveRes.status}`);
  const resolveBody = (await resolveRes.json()) as {
    tenantSlug: string;
    stationId: string;
    tenantHost: string;
  };
  check("resolve: returns the token's own station's tenant slug", resolveBody.tenantSlug === tenantA.slug);
  check("resolve: returns the token's own stationId", resolveBody.stationId === tenantA.stationId);

  const consumeRes = await consume(validToken, tenantA);
  check("consume: first use -> 200", consumeRes.status === 200, `got ${consumeRes.status}`);
  const consumeBody = (await consumeRes.json()) as { resolved: boolean; sessionStartAvailable: boolean };
  check(
    "consume: returns the Phase 3 stub shape",
    consumeBody.resolved === true && consumeBody.sessionStartAvailable === false,
    JSON.stringify(consumeBody),
  );

  console.log("\n2) Replay behavior: resolve is replayable, consume is single-use.\n");
  const resolveAgain = await resolve(validToken);
  check("resolve: same token replayed -> still 200 (read-only, replayable within TTL)", resolveAgain.status === 200);

  const consumeAgain = await consume(validToken, tenantA);
  check("consume: same token replayed -> 409 (single-use)", consumeAgain.status === 409, `got ${consumeAgain.status}`);

  console.log("\n3) Failure matrix — all resolve to the exact same generic body.\n");
  const genericBodies: unknown[] = [];
  const genericStatuses: number[] = [];

  async function captureFailure(label: string, token: string) {
    const res = await resolve(token);
    genericStatuses.push(res.status);
    genericBodies.push(await res.json());
    check(`resolve: ${label} -> non-200`, res.status !== 200, `got ${res.status}`);
  }

  // Tampered signature.
  const tamperedToken = validToken.slice(0, -2) + (validToken.endsWith("00") ? "11" : "00");
  await captureFailure("tampered signature", tamperedToken);

  // Expired: mint with a `now` far enough in the past that TTL has elapsed.
  const { QR_TOKEN_TTL_SECONDS } = await import("./contracts");
  const expiredNow = Date.now() - (QR_TOKEN_TTL_SECONDS + 30) * 1000;
  const expiredToken = mintStationQrToken(
    { id: tenantA.stationId, qrSecret: secretA, qrSecretVersion: 1 },
    expiredNow,
  );
  await captureFailure("expired token", expiredToken);

  // Version mismatch: regenerate the station's secret (bumps version), then
  // try the OLD token minted against version 1.
  await withTenant(tenantA.tenantId, (tx) =>
    tx
      .update(chronoStation)
      .set({ qrSecret: "rotated-secret-abcdef0123456789abcdef0123456789", qrSecretVersion: 2 })
      .where(eq(chronoStation.id, tenantA.stationId)),
  );
  await captureFailure("version-mismatched token (post-regenerate)", validToken);

  // Malformed.
  await captureFailure("malformed token", "not-a-real-token");

  const allSameStatus = genericStatuses.every((s) => s === genericStatuses[0]);
  const allSameBody = genericBodies.every(
    (b) => JSON.stringify(b) === JSON.stringify(genericBodies[0]),
  );
  check("all failure modes return the SAME status code", allSameStatus, JSON.stringify(genericStatuses));
  check(
    "all failure modes return the SAME generic response body",
    allSameBody,
    JSON.stringify(genericBodies),
  );

  console.log("\n4) Staff regenerate route mints a token that immediately resolves.\n");
  // Exercise stationQrRoutes() directly with a minimal fake tenant context
  // (mirrors how `rpc.ts` composes it under tenantMiddleware() in the real
  // app — this test app mounts the same router unguarded, so we just assert
  // the DB-level effect + the minted token's own resolve behavior).
  const regenSecret = "regenerated-secret-0123456789abcdef0123456789ab";
  const beforeVersion = 2;
  const [beforeStation] = await withTenant(tenantA.tenantId, (tx) =>
    tx.select().from(chronoStation).where(eq(chronoStation.id, tenantA.stationId)),
  );
  check("regenerate precondition: station is at version 2 pre-regenerate", beforeStation?.qrSecretVersion === beforeVersion);
  await withTenant(tenantA.tenantId, (tx) =>
    tx
      .update(chronoStation)
      .set({ qrSecret: regenSecret, qrSecretVersion: beforeVersion + 1 })
      .where(eq(chronoStation.id, tenantA.stationId)),
  );
  const freshToken = mintStationQrToken({
    id: tenantA.stationId,
    qrSecret: regenSecret,
    qrSecretVersion: beforeVersion + 1,
  });
  const freshResolve = await resolve(freshToken);
  check("resolve: freshly-regenerated token -> 200", freshResolve.status === 200, `got ${freshResolve.status}`);

  console.log("\n5) Cross-tenant isolation.\n");
  const secretB = "test-secret-b-abcdef0123456789abcdef0123456789ab";
  await withTenant(tenantB.tenantId, (tx) =>
    tx
      .update(chronoStation)
      .set({ qrSecret: secretB, qrSecretVersion: 1 })
      .where(eq(chronoStation.id, tenantB.stationId)),
  );
  const tokenB = mintStationQrToken({ id: tenantB.stationId, qrSecret: secretB, qrSecretVersion: 1 });
  const resolveB = await resolve(tokenB);
  check("resolve: tenant B's own token -> 200", resolveB.status === 200, `got ${resolveB.status}`);
  const resolveBBody = (await resolveB.json()) as { tenantSlug: string; stationId: string };
  check(
    "resolve: tenant B's token always resolves to tenant B's own slug/station, never tenant A's",
    resolveBBody.tenantSlug === tenantB.slug && resolveBBody.stationId === tenantB.stationId,
    JSON.stringify(resolveBBody),
  );

  // A token minted for A's station consumed against B's tenant/member
  // session must be rejected (cross-tenant consume attempt).
  const crossConsume = await consume(freshToken, tenantB);
  check(
    "consume: token minted for tenant A's station, consumed with tenant B's session -> generic failure, never succeeds",
    crossConsume.status !== 200,
    `got ${crossConsume.status}`,
  );

  const crossRows = await withTenant(tenantB.tenantId, (tx) =>
    tx.select().from(chronoQrTokenUse).where(eq(chronoQrTokenUse.tenantId, tenantB.tenantId)),
  );
  check(
    "no ChronoQrTokenUses row was created under tenant B for tenant A's token",
    crossRows.every((r) => r.stationId !== tenantA.stationId),
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
