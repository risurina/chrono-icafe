/**
 * Self-contained end-to-end test — one command: `pnpm test:e2e`.
 *
 * Runs the REAL app against an in-process Postgres (PGlite, DB_DRIVER=pglite):
 * generates the schema + RLS, seeds two tenants, starts the real Hono server,
 * and drives the full HTTP surface — public tenant lookup, staff auth + RPC +
 * role gating, customer auth, and cross-tenant isolation (HTTP + DB level).
 * No external database, no Docker. Exits non-zero if any assertion fails.
 */
import "dotenv/config"; // load apps/api/.env → picks up TEST_DATABASE_URL
import { createHash, createHmac } from "node:crypto";
import { is, Column } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";

/** Decode an RFC 4648 base32 string (no padding) to bytes. */
function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** Compute an RFC 6238 TOTP (SHA-1, 6 digits, 30s step) for the current time. */
function totp(secretBase32: string, forTime = Date.now()): string {
  const key = base32Decode(secretBase32);
  const counter = Math.floor(forTime / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (bin % 1_000_000).toString().padStart(6, "0");
}

/** Emit CREATE TABLE from the Drizzle schema (no drizzle-kit needed at runtime). */
function tableDdl(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    let s = `"${c.name}" ${c.getSQLType()}`;
    if (c.primary) s += " primary key";
    if (c.notNull) s += " not null";
    if (c.default !== undefined) {
      // Literal defaults: booleans/numbers inline; strings quoted; plain
      // objects/arrays rendered as a JSON literal cast to the column type.
      // Anything else (Drizzle's defaultNow() SQL object, which carries
      // queryChunks) → now(). Getting these right matters: organization.status
      // defaults to 'active', and a wrong `default now()` would poison the
      // tenant-lifecycle status check — or, for a jsonb column, fail outright
      // with "type jsonb but default expression is of type timestamp".
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

/**
 * Emit `CREATE UNIQUE INDEX` for each unique index on a table. Needed so
 * `onConflict`/upsert targets (e.g. tenant_branding.tenant_id) have the matching
 * constraint — `tableDdl` above only emits columns.
 */
function uniqueIndexDdls(table: PgTable): string[] {
  const cfg = getTableConfig(table);
  return cfg.indexes
    .filter((i) => i.config.unique)
    .map((i) => {
      const cols = (i.config.columns as { name: string }[])
        .map((c) => `"${c.name}"`)
        .join(", ");
      // Include the index's `.where()` predicate — a partial unique index applies
      // as a FULL unique constraint if this is dropped, causing false collisions
      // unrelated to the invariant it enforces (reservations-queue-and-self-
      // service plan, round-2 audit CONDITION 5 — fixed identically in all four
      // harnesses that duplicate this helper).
      const where = i.config.where;
      const whereSql = where ? ` where ${sqlToText(where)}` : "";
      return `create unique index if not exists "${i.config.name}" on "${cfg.name}" (${cols})${whereSql};`;
    });
}

function sqlToText(fragment: unknown): string {
  const chunks = (fragment as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (is(chunk, Column)) return `"${chunk.name}"`;
      if (chunk && typeof chunk === "object" && "value" in (chunk as Record<string, unknown>)) {
        const v = (chunk as { value: unknown }).value;
        return Array.isArray(v) ? v.join("") : String(v);
      }
      return String(chunk);
    })
    .join("");
}

// ── tiny assertion harness ──
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
  // ── choose the target database ──
  // TEST_DATABASE_URL set → run against a REAL Postgres (drop → migrate → seed).
  // unset → in-process PGlite (zero setup, offline/CI friendly).
  const testUrl = process.env.TEST_DATABASE_URL;
  const REAL = !!testUrl;

  if (REAL) {
    // Guard: never nuke the dev/prod database.
    if (process.env.DATABASE_URL && process.env.DATABASE_URL === testUrl) {
      die("TEST_DATABASE_URL must differ from DATABASE_URL — refusing to drop your main DB.");
    }
    let dbName = "";
    try {
      dbName = new URL(testUrl!).pathname.replace(/^\//, "");
    } catch {
      die("TEST_DATABASE_URL is not a valid connection URL.");
    }
    if (!/test/i.test(dbName) && process.env.E2E_ALLOW_DESTRUCTIVE !== "1") {
      die(
        `Refusing to drop tables on database "${dbName}" — its name doesn't contain "test".\n` +
          `  Point TEST_DATABASE_URL at a dedicated test database, or set E2E_ALLOW_DESTRUCTIVE=1 to override.`,
      );
    }
    // Use a DIRECT (non-pooled) connection: we SET ROLE for the HTTP phase, and
    // a pgbouncer pooler (Neon's `-pooler` host) would leak that role onto a
    // shared server connection. A single direct session can't leak.
    const url = new URL(testUrl!);
    url.hostname = url.hostname.replace("-pooler", "");
    process.env.DATABASE_URL = url.toString();
    delete process.env.DATABASE_URL_ADMIN; // single database
    // One connection so the SET ROLE below (non-bypass role) persists across
    // queries — otherwise a second connection would still be the bypass owner.
    process.env.DB_POOL_MAX = "1";
    console.log(`\ne2e mode: REAL database "${dbName}" (direct connection)`);
  } else {
    process.env.DB_DRIVER = "pglite";
    console.log("\ne2e mode: in-process PGlite (set TEST_DATABASE_URL to use a real DB)");
  }

  // 0. Common app env.
  process.env.APP_DOMAIN = "localtest.me:3000";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
  process.env.WEB_ORIGIN = "http://localtest.me:3000";
  process.env.NODE_ENV = "test";
  // The whole platform-admin mutating surface is exercised as one actor inside
  // a single 60s window; lift the per-actor mutate ceiling (prod default 20) so
  // the suite is not throttled by a DoS knob unrelated to what it asserts.
  process.env.PLATFORM_ADMIN_MUTATE_MAX = "1000";
  // Custom-domain provisioning: local no-op provider; internal recheck secret.
  process.env.DOMAIN_PROVIDER = "noop";
  process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
  // Billing: a webhook signing secret (so /billing/webhook verifies signatures)
  // but NO STRIPE_SECRET_KEY — isBillingEnabled() stays false, so checkout/portal
  // are inert while webhook sync + entitlements are fully exercised.
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_e2e_test_secret";
  // Social sign-in: dummy Google credentials so the provider counts as
  // CONFIGURED and the flag/gate round trip is exercised for real. Facebook is
  // deliberately left unconfigured so the "cannot enable a provider with no
  // credentials" guard has a subject. No IdP is ever contacted — every
  // assertion stops at our own gate.
  process.env.GOOGLE_AUTH_KEY = "e2e-google-client-id";
  process.env.GOOGLE_AUTH_SECRET = "e2e-google-client-secret";
  delete process.env.FACEBOOK_AUTH_KEY;
  delete process.env.FACEBOOK_AUTH_SECRET;
  // 32-byte key (base64) so SSO client secrets can be encrypted at rest.
  process.env.SSO_ENC_KEY = Buffer.alloc(32, 7).toString("base64");
  // Branding uploads → an ephemeral dir so the e2e leaves no artifacts in-tree.
  const os = await import("node:os");
  const path = await import("node:path");
  process.env.STORAGE_PROVIDER = "local";
  process.env.STORAGE_LOCAL_DIR = path.join(os.tmpdir(), "agora-e2e-uploads");
  // Webhooks: allow loopback delivery to the in-test stub receiver, and use
  // fast/small worker limits so retry→disable is observable within the run.
  process.env.WEBHOOK_INSECURE_HOSTS = "127.0.0.1";
  process.env.QUEUE_WEBHOOKS_MAX_ATTEMPTS = "5";
  process.env.QUEUE_WEBHOOKS_DISABLE_THRESHOLD = "3";
  process.env.QUEUE_WEBHOOKS_BACKOFF_BASE_MS = "1";
  process.env.QUEUE_WEBHOOKS_BACKOFF_MAX_MS = "2";
  process.env.QUEUE_WEBHOOKS_TIMEOUT_MS = "1000";

  // 1. Register Chrono's own permission resources BEFORE anything imports
  // agora/auth (which freezes the shared registry on first read) — the app
  // import below is what triggers that freeze.
  const { registerChronoPermissions } = await import("../auth/permissions");
  registerChronoPermissions();

  // 2. Import the app + foundation (this connects the db).
  const { app } = await import("../app");
  const { auth } = await import("agora/auth");
  const { setDnsResolver } = await import("agora/server");
  const {
    adminDb,
    adminPool,
    pool,
    withTenant,
    withAdmin,
    schema,
    eq,
    and,
    sql,
    inArray,
    applyRls,
    BASE_TENANT_TABLES,
  } = await import("agora/db");
  const {
    APP_TENANT_TABLES,
    project,
    auditEvent,
    tenantBranding,
    tenantFeatureFlag,
    webhookEndpoint,
    job,
    platformAuditEvent,
    domain,
    tenantSubscription,
    tenantSubscriptionEvent,
    tenantSsoConnection,
    tenantIntegration,
    billingEvent,
    paymentTransaction,
    storedFile,
    chronoBusinessLead,
    chronoCompanyInquiry,
  } = await import("../db/schema");
  const { createId, WORKSPACE_SUSPENDED } = await import("agora");
  const { verifyWebhookSignature, registerEmailQueueJob } = await import("agora/server");
  const { runQueueOnce } = await import("agora/queue");
  const { registerWebhookQueueJob } = await import("agora/webhooks");
  const { signStripePayload, getBillingWebhookProvider, __setBillingProvider } =
    await import("agora/billing");

  // The e2e harness imports `../app` directly (never `index.ts`), so — same as
  // that real bootstrap — job handlers must be registered before any
  // `runQueueOnce(...)` call below can process a dispatched job.
  registerEmailQueueJob();
  registerWebhookQueueJob();

  const appSchema = await import("../db/schema");
  const tables = Object.values(appSchema).filter((v) => is(v, PgTable)) as PgTable[];

  // 2. Reset → migrate (create schema) → RLS.
  if (REAL) {
    console.log("  dropping all tables…");
    // Clean slate: drop anything the e2e role owns from a previous run (it may
    // own tables/grants), then drop our tables. Dropping tables individually
    // avoids needing to own the `public` schema (Neon manages it).
    await pool.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_e2e') THEN
        EXECUTE 'DROP OWNED BY app_e2e CASCADE';
      END IF;
    END $$;`);
    for (const t of tables) {
      await pool.query(
        `DROP TABLE IF EXISTS "${getTableConfig(t).name}" CASCADE;`,
      );
    }
    console.log("  running migration (schema push)…");
    for (const t of tables) await pool.query(tableDdl(t));
    for (const t of tables)
      for (const ddl of uniqueIndexDdls(t)) await pool.query(ddl);
  } else {
    await (pool as unknown as { exec: (sql: string) => Promise<unknown> }).exec(
      [
        ...tables.map(tableDdl),
        ...tables.flatMap(uniqueIndexDdls),
      ].join("\n"),
    );
  }
  await applyRls(adminPool, [...BASE_TENANT_TABLES, ...APP_TENANT_TABLES]);

  // 3. Seed two tenants (staff + a project each).
  if (REAL) console.log("  seeding…");
  const PW = "Password123!";
  async function ensureStaff(email: string, name: string): Promise<string> {
    const r = await auth.api.signUpEmail({ body: { email, password: PW, name } });
    return r.user.id;
  }
  async function ensureOrg(slug: string, name: string): Promise<string> {
    const id = createId();
    await adminDb.insert(schema.organization).values({ id, slug, name });
    return id;
  }
  async function addMember(orgId: string, userId: string, role: string) {
    await adminDb
      .insert(schema.member)
      .values({ id: createId(), organizationId: orgId, userId, role });
  }

  const acmeOwner = await ensureStaff("owner@acme.test", "Acme Owner");
  const acmeStaff = await ensureStaff("staff@acme.test", "Acme Staff");
  const contosoOwner = await ensureStaff("owner@contoso.test", "Contoso Owner");
  const acmeId = await ensureOrg("acme", "Acme Corp");
  const contosoId = await ensureOrg("contoso", "Contoso Ltd");
  await addMember(acmeId, acmeOwner, "owner");
  await addMember(acmeId, acmeStaff, "staff");
  await addMember(contosoId, contosoOwner, "owner");
  await withTenant(acmeId, (tx) =>
    tx.insert(project).values({ id: createId(), tenantId: acmeId, name: "Acme Seed" }),
  );
  const [contosoProject] = await withTenant(contosoId, (tx) =>
    tx
      .insert(project)
      .values({ id: createId(), tenantId: contosoId, name: "Contoso Seed" })
      .returning(),
  );

  // 3b. RLS is only enforced for a role that is NEITHER a superuser NOR has
  //     BYPASSRLS. That's a real gotcha: PGlite connects as a superuser, and
  //     Neon's default `neondb_owner` has BYPASSRLS — both silently bypass RLS.
  //     If the current role bypasses RLS, switch to a plain role for the HTTP
  //     phase so isolation is genuinely exercised. (Schema + seed ran above as
  //     the privileged role.) When the connection is already a plain role — e.g.
  //     CI's provisioned test role — this is a no-op.
  const roleRes = (await pool.query(
    `SELECT (rolsuper OR rolbypassrls) AS b FROM pg_roles WHERE rolname = current_user`,
  )) as { rows: Array<{ b: boolean }> };
  const bypasses = roleRes.rows[0]?.b ?? false;
  if (bypasses) {
    await pool.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_e2e') THEN
        CREATE ROLE app_e2e NOSUPERUSER NOBYPASSRLS;
      END IF;
      EXECUTE format('GRANT app_e2e TO %I', current_user); -- membership → SET ROLE
    END $$;`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO app_e2e;`);
    await pool.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO app_e2e;`);
    // Re-assert the non-bypass role on EVERY (re)connection. A session-level
    // SET ROLE is lost if the single pooled connection is dropped/recycled
    // mid-run (Neon idle close, transient error); the new connection would
    // silently revert to the bypassing owner and defeat the isolation checks.
    // The `connect` hook fires first on each fresh connection (queries are
    // FIFO per connection), so the role is set before any tenant query runs.
    const poolWithEvents = pool as unknown as {
      on?: (event: string, cb: (client: { query: (sql: string) => Promise<unknown> }) => void) => void;
    };
    poolWithEvents.on?.("connect", (client) => {
      void client.query("SET ROLE app_e2e");
    });
    await pool.query(`SET ROLE app_e2e;`);
  }

  // 4. Start the real HTTP server on an ephemeral port.
  const { serve } = await import("@hono/node-server");
  let server: { close: (cb?: () => void) => void };
  const port: number = await new Promise((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });
  const base = `http://127.0.0.1:${port}`;

  // ── HTTP helper with a manual cookie jar ──
  type Res = { status: number; body: any; setCookie: string[] };
  async function req(
    method: string,
    path: string,
    opts: {
      slug?: string;
      host?: string;
      cookie?: string;
      json?: unknown;
      bearer?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<Res> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.slug) headers["x-tenant-slug"] = opts.slug;
    if (opts.host) headers["x-tenant-host"] = opts.host;
    if (opts.cookie) headers["cookie"] = opts.cookie;
    if (opts.bearer) headers["authorization"] = `Bearer ${opts.bearer}`;
    if (opts.json !== undefined) headers["content-type"] = "application/json";
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, setCookie };
  }
  // `req()` follows redirects, which is right for JSON POSTs but useless for
  // the OAuth routes below: `/start` and `/callback` are 302s whose Location
  // header IS the assertion (the authorize URL to inspect; the final
  // portal/apex destination). This variant stops at the redirect and hands
  // it back instead of chasing it.
  type NoFollowRes = { status: number; body: unknown; setCookie: string[]; location: string | null };
  async function reqNoFollow(
    method: string,
    path: string,
    opts: { slug?: string; host?: string; cookie?: string; headers?: Record<string, string> } = {},
  ): Promise<NoFollowRes> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.slug) headers["x-tenant-slug"] = opts.slug;
    if (opts.host) headers["x-tenant-host"] = opts.host;
    if (opts.cookie) headers["cookie"] = opts.cookie;
    const res = await fetch(`${base}${path}`, { method, headers, redirect: "manual" });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const text = await res.text().catch(() => "");
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, setCookie, location: res.headers.get("location") };
  }
  const jar = (cookies: string[]) => cookies.map((c) => c.split(";")[0]).join("; ");
  async function staffCookie(email: string): Promise<string> {
    const r = await auth.api.signInEmail({ body: { email, password: PW }, asResponse: true });
    return jar(r.headers.getSetCookie());
  }
  // The console email provider logs `link=<url>`; capture it to recover the raw
  // single-use token an email flow would deliver (invite / password reset).
  async function captureEmailLinks<T>(
    fn: () => Promise<T>,
  ): Promise<{ result: T; tokens: string[] }> {
    const orig = console.log;
    const tokens: string[] = [];
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      const m = line.match(/link=(\S+)/);
      if (m) {
        try {
          const t = new URL(m[1]!).searchParams.get("token");
          if (t) tokens.push(t);
        } catch {
          /* ignore non-URL */
        }
      }
    };
    try {
      const result = await fn();
      return { result, tokens };
    } finally {
      console.log = orig;
    }
  }

  // Same console-log interception as captureEmailLinks, but recovers the
  // `to=` recipient of every console-provider send — for asserting an
  // exact-count email fan-out (e.g. growth-loop-hardening's onPublish hook)
  // rather than recovering a single-use token. `settleMs` gives a
  // fire-and-forget hook (called with `void hook().catch(...)`, never
  // awaited by the route itself) time to finish before the interception is
  // torn down.
  async function captureEmailSends<T>(
    fn: () => Promise<T>,
    settleMs = 500,
  ): Promise<{ result: T; sentTo: string[] }> {
    const orig = console.log;
    const sentTo: string[] = [];
    console.log = (...args: unknown[]) => {
      const line = args.map(String).join(" ");
      const m = line.match(/^\[email:console\] to=(\S+)/);
      if (m) sentTo.push(m[1]!);
    };
    try {
      const result = await fn();
      await new Promise((r) => setTimeout(r, settleMs));
      return { result, sentTo };
    } finally {
      console.log = orig;
    }
  }

  // ── the checks ──
  console.log("\nRunning e2e checks:\n");

  // A. Public tenant lookup (no auth).
  const pub = await req("GET", "/public/tenant", { slug: "acme" });
  check(
    "public/tenant resolves acme",
    pub.status === 200 && pub.body?.tenant?.slug === "acme",
    JSON.stringify(pub.body),
  );

  // B. Staff owner context.
  const ownerCk = await staffCookie("owner@acme.test");
  const me = await req("GET", "/rpc/me", { slug: "acme", cookie: ownerCk });
  check(
    "staff owner /rpc/me",
    me.status === 200 && me.body?.role === "owner" && me.body?.tenantSlug === "acme",
    `status ${me.status} ${JSON.stringify(me.body)}`,
  );

  // C. Staff creates + lists a project.
  const created = await req("POST", "/rpc/projects", {
    slug: "acme",
    cookie: ownerCk,
    json: { name: "E2E Project" },
  });
  check(
    "staff creates project",
    created.status === 201 && created.body?.project?.name === "E2E Project",
    `status ${created.status}`,
  );
  const list = await req("GET", "/rpc/projects", { slug: "acme", cookie: ownerCk });
  const names: string[] = (list.body?.items ?? []).map((p: any) => p.name);
  check("project list includes new + seed", names.includes("E2E Project") && names.includes("Acme Seed"), names.join(","));
  check("staff sees only acme rows", (list.body?.items ?? []).every((p: any) => p.tenantId === acmeId));

  // D. Role gating: a staff-role user cannot delete.
  const staffCk = await staffCookie("staff@acme.test");
  const newId = created.body?.project?.id as string;
  const delAsStaff = await req("DELETE", `/rpc/projects/${newId}`, { slug: "acme", cookie: staffCk });
  check("staff role blocked from delete (403)", delAsStaff.status === 403, `status ${delAsStaff.status}`);
  const delAsOwner = await req("DELETE", `/rpc/projects/${newId}`, { slug: "acme", cookie: ownerCk });
  check("owner can delete (200)", delAsOwner.status === 200, `status ${delAsOwner.status}`);

  // E. HTTP tenant isolation: acme owner cannot act on contoso.
  const wrongTenant = await req("GET", "/rpc/me", { slug: "contoso", cookie: ownerCk });
  check("acme owner rejected on contoso (403)", wrongTenant.status === 403, `status ${wrongTenant.status}`);

  // F. Customer sign-up + me.
  const cSignup = await req("POST", "/portal/auth/sign-up", {
    slug: "acme",
    json: { email: "cust@acme.test", name: "Acme Cust", password: PW },
  });
  check("customer sign-up (201)", cSignup.status === 201, `status ${cSignup.status}`);
  const custCk = jar(cSignup.setCookie);
  const cMe = await req("GET", "/portal/auth/me", { slug: "acme", cookie: custCk });
  check(
    "customer /me",
    cMe.status === 200 && cMe.body?.member?.email === "cust@acme.test",
    `status ${cMe.status} ${JSON.stringify(cMe.body)}`,
  );

  // G. Customer isolation: same session invalid on another tenant; same email re-registers.
  const cMeCross = await req("GET", "/portal/auth/me", { slug: "contoso", cookie: custCk });
  check("customer session invalid cross-tenant (401)", cMeCross.status === 401, `status ${cMeCross.status}`);
  const cSignup2 = await req("POST", "/portal/auth/sign-up", {
    slug: "contoso",
    json: { email: "cust@acme.test", name: "Contoso Cust", password: PW },
  });
  check("same email registers on another tenant (201)", cSignup2.status === 201, `status ${cSignup2.status}`);

  // H. Customer cannot reach the back-office.
  const custToRpc = await req("GET", "/rpc/me", { slug: "acme", cookie: custCk });
  check("customer blocked from /rpc (401)", custToRpc.status === 401, `status ${custToRpc.status}`);

  // ── Chrono member portal (loyalty, session, credit catalog+purchase, promos, wallet history filter) ──
  {
    const { chronoCreditProduct } = await import("../modules/credit/schema");
    const { creditWallet } = await import("../modules/wallet/service");
    const { chronoBranch } = await import("../modules/branch/schema");
    const { chronoStation } = await import("../modules/station/schema");
    const { chronoSession } = await import("../modules/session/schema");
    const { chronoPromo } = await import("../modules/promo/schema");

    // A member/customer on acme, distinct from the earlier `custCk`.
    const mSignup = await req("POST", "/portal/auth/sign-up", {
      slug: "acme",
      json: { email: "portalmember@acme.test", name: "Portal Member", password: PW },
    });
    check("portal member sign-up (201)", mSignup.status === 201, `status ${mSignup.status}`);
    const memberCk = jar(mSignup.setCookie);
    const meRes = await req("GET", "/portal/auth/me", { slug: "acme", cookie: memberCk });
    const memberId: string = meRes.body?.member?.memberId;

    // Loyalty — no earn history yet → account null, bronze/0%.
    const loyaltyMe = await req("GET", "/portal/loyalty/me", { slug: "acme", cookie: memberCk });
    check(
      "loyalty/me: new member has no account, bronze level",
      loyaltyMe.status === 200 && loyaltyMe.body?.account === null && loyaltyMe.body?.level?.tier === "bronze",
      JSON.stringify(loyaltyMe.body),
    );
    const loyaltyStaffGate = await req("GET", "/portal/loyalty/me", { slug: "acme", cookie: ownerCk });
    check("loyalty/me: staff cookie rejected (401)", loyaltyStaffGate.status === 401, `status ${loyaltyStaffGate.status}`);
    const loyaltyCross = await req("GET", "/portal/loyalty/me", { slug: "contoso", cookie: memberCk });
    check("loyalty/me: cross-tenant session rejected (401)", loyaltyCross.status === 401, `status ${loyaltyCross.status}`);

    // Session — no sessions yet.
    const sumEmpty = await req("GET", "/portal/sessions/summary", { slug: "acme", cookie: memberCk });
    check(
      "sessions/summary: no active session, zero usage today",
      sumEmpty.status === 200 && sumEmpty.body?.active === null && sumEmpty.body?.today?.sessionCount === 0,
      JSON.stringify(sumEmpty.body),
    );
    const listEmpty = await req("GET", "/portal/sessions", { slug: "acme", cookie: memberCk });
    check("sessions list: empty for a new member", listEmpty.status === 200 && listEmpty.body?.items?.length === 0, JSON.stringify(listEmpty.body));

    // Seed a branch + station + an ended session for this member directly (portal
    // routes are read-only for sessions; staff-side session creation is a
    // separate, already-covered module).
    const [branch] = await withTenant(acmeId, (tx) =>
      tx.insert(chronoBranch).values({ id: createId(), tenantId: acmeId, name: "Main", code: "MAIN" }).returning(),
    );
    const [station] = await withTenant(acmeId, (tx) =>
      tx
        .insert(chronoStation)
        .values({ id: createId(), tenantId: acmeId, branchId: branch!.id, name: "PC-01", stationNumber: "1" })
        .returning(),
    );
    const startedAt = new Date();
    const [endedSession] = await withTenant(acmeId, (tx) =>
      tx
        .insert(chronoSession)
        .values({
          id: createId(),
          tenantId: acmeId,
          branchId: branch!.id,
          stationId: station!.id,
          memberId,
          status: "ended",
          startedAt,
          endedAt: new Date(startedAt.getTime() + 3600_000),
          actualBillableSeconds: 3600,
          amountCharged: "50.00",
          currency: "PHP",
          rateSnapshot: "50.00",
          rateSource: "group_hourly",
        })
        .returning(),
    );
    const listAfter = await req("GET", "/portal/sessions", { slug: "acme", cookie: memberCk });
    check(
      "sessions list: newest-first, includes the ended session",
      listAfter.status === 200 && listAfter.body?.items?.[0]?.id === endedSession!.id,
      JSON.stringify(listAfter.body),
    );
    const detail = await req("GET", `/portal/sessions/${endedSession!.id}`, { slug: "acme", cookie: memberCk });
    check("session detail: own session found", detail.status === 200 && detail.body?.session?.id === endedSession!.id, JSON.stringify(detail.body));
    const detailForeign = await req("GET", `/portal/sessions/${endedSession!.id}`, { slug: "acme", cookie: custCk });
    check("session detail: another member's session 404s (no leak)", detailForeign.status === 404, `status ${detailForeign.status}`);
    const detailWrongTenant = await req("GET", `/portal/sessions/${endedSession!.id}`, { slug: "contoso", cookie: memberCk });
    check("session detail: cross-tenant session id 401s", detailWrongTenant.status === 401, `status ${detailWrongTenant.status}`);
    const sumAfter = await req("GET", "/portal/sessions/summary", { slug: "acme", cookie: memberCk });
    check(
      "sessions/summary: today's usage reflects the ended session",
      sumAfter.status === 200 && sumAfter.body?.today?.sessionCount === 1 && sumAfter.body?.today?.billableSeconds === 3600,
      JSON.stringify(sumAfter.body),
    );

    // Credit catalog + wallet-funded purchase.
    const [draftProduct] = await withTenant(acmeId, (tx) =>
      tx
        .insert(chronoCreditProduct)
        .values({
          id: createId(),
          tenantId: acmeId,
          name: "Draft Pack",
          code: "DRAFT-1",
          status: "draft",
          quantityMinutes: 60,
          priceAmount: "100.00",
        })
        .returning(),
    );
    const [activeProduct] = await withTenant(acmeId, (tx) =>
      tx
        .insert(chronoCreditProduct)
        .values({
          id: createId(),
          tenantId: acmeId,
          name: "Starter Pack",
          code: "START-1",
          status: "active",
          quantityMinutes: 60,
          priceAmount: "100.00",
        })
        .returning(),
    );
    const catalog = await req("GET", "/portal/credits/products", { slug: "acme", cookie: memberCk });
    const catalogIds: string[] = (catalog.body?.items ?? []).map((p: { id: string }) => p.id);
    check(
      "credits/products: only active products, draft hidden",
      catalog.status === 200 && catalogIds.includes(activeProduct!.id) && !catalogIds.includes(draftProduct!.id),
      JSON.stringify(catalog.body),
    );

    // Empty wallet → 422, no rows written.
    const purchaseNoFunds = await req("POST", "/portal/credits/purchase", {
      slug: "acme",
      cookie: memberCk,
      json: { productId: activeProduct!.id },
    });
    check("credits/purchase: insufficient balance (422)", purchaseNoFunds.status === 422, `status ${purchaseNoFunds.status} ${JSON.stringify(purchaseNoFunds.body)}`);

    // Fund the wallet, then purchase succeeds.
    await withTenant(acmeId, (tx) => creditWallet(tx, { tenantId: acmeId, memberId, amount: "200.00", reason: "e2e top-up" }));
    const purchaseOk = await req("POST", "/portal/credits/purchase", {
      slug: "acme",
      cookie: memberCk,
      json: { productId: activeProduct!.id },
    });
    check("credits/purchase: succeeds with sufficient balance (201)", purchaseOk.status === 201, `status ${purchaseOk.status} ${JSON.stringify(purchaseOk.body)}`);
    const balanceAfterPurchase = await req("GET", "/portal/wallet/balance", { slug: "acme", cookie: memberCk });
    check(
      "wallet/balance: debited by the purchase price",
      balanceAfterPurchase.body?.balance === "100.00",
      JSON.stringify(balanceAfterPurchase.body),
    );
    const purchaseForeignProduct = await req("POST", "/portal/credits/purchase", {
      slug: "contoso",
      cookie: custCk,
      json: { productId: activeProduct!.id },
    });
    check(
      "credits/purchase: foreign tenant's product id rejected",
      purchaseForeignProduct.status === 401 || purchaseForeignProduct.status === 404,
      `status ${purchaseForeignProduct.status}`,
    );

    // Wallet history "last top-up" filter.
    const lastTopUp = await req("GET", "/portal/wallet/history?type=credit&pageSize=1", { slug: "acme", cookie: memberCk });
    check(
      "wallet/history?type=credit: only credit rows, newest first",
      lastTopUp.status === 200 && lastTopUp.body?.items?.length === 1 && lastTopUp.body?.items?.[0]?.type === "credit",
      JSON.stringify(lastTopUp.body),
    );

    // Promos — none active yet.
    const promosEmpty = await req("GET", "/portal/promos", { slug: "acme", cookie: memberCk });
    check("promos: empty when none active", promosEmpty.status === 200 && promosEmpty.body?.items?.length === 0, JSON.stringify(promosEmpty.body));
    const now = new Date();
    await withTenant(acmeId, (tx) =>
      tx.insert(chronoPromo).values({
        id: createId(),
        tenantId: acmeId,
        name: "Happy Hour",
        code: "HAPPY10",
        status: "active",
        discountType: "percentage",
        discountValue: "10",
        endsAt: new Date(now.getTime() + 86_400_000),
      }),
    );
    const promosAfter = await req("GET", "/portal/promos", { slug: "acme", cookie: memberCk });
    check(
      "promos: shows an active in-window promo",
      promosAfter.status === 200 && promosAfter.body?.items?.some((p: { code: string }) => p.code === "HAPPY10"),
      JSON.stringify(promosAfter.body),
    );
    const contosoMemberSignup = await req("POST", "/portal/auth/sign-up", {
      slug: "contoso",
      json: { email: "portalmember@contoso.test", name: "Contoso Member", password: PW },
    });
    const contosoMemberCk = jar(contosoMemberSignup.setCookie);
    const promosCross = await req("GET", "/portal/promos", { slug: "contoso", cookie: contosoMemberCk });
    check(
      "promos: contoso member never sees acme's promo",
      promosCross.status === 200 && !promosCross.body?.items?.some((p: { code: string }) => p.code === "HAPPY10"),
      JSON.stringify(promosCross.body),
    );
  }

  // ── Chrono station board (GET /rpc/stations/board) ──
  // station-control-grouping plan, Phase 1: offline (non-Playwright)
  // coverage for the aggregate read the Station Control board is built on —
  // this is the only coverage that runs without a human driving Playwright.
  {
    const { chronoBranch } = await import("../modules/branch/schema");
    const { chronoStation, chronoStationGroup } = await import("../modules/station/schema");

    const [boardBranch] = await withTenant(acmeId, (tx) =>
      tx
        .insert(chronoBranch)
        .values({ id: createId(), tenantId: acmeId, name: "Board Branch", code: "BOARD" })
        .returning(),
    );
    const [boardGroup] = await withTenant(acmeId, (tx) =>
      tx
        .insert(chronoStationGroup)
        .values({
          id: createId(),
          tenantId: acmeId,
          branchId: boardBranch!.id,
          name: "Board Group",
          code: "BOARDGRP",
          hourlyRate: "10.00",
        })
        .returning(),
    );
    const [groupedStation] = await withTenant(acmeId, (tx) =>
      tx
        .insert(chronoStation)
        .values({
          id: createId(),
          tenantId: acmeId,
          branchId: boardBranch!.id,
          stationGroupId: boardGroup!.id,
          name: "Board PC 1",
          stationNumber: "BP-01",
        })
        .returning(),
    );
    const [ungroupedStation] = await withTenant(acmeId, (tx) =>
      tx
        .insert(chronoStation)
        .values({
          id: createId(),
          tenantId: acmeId,
          branchId: boardBranch!.id,
          name: "Board PC 2",
          stationNumber: "BP-02",
        })
        .returning(),
    );

    // Happy read: staff owner sees both stations, group name denormalized,
    // no active session on either (none started), no `qrSecret` leak.
    const boardOwner = await req("GET", `/rpc/stations/board?branchId=${boardBranch!.id}`, {
      slug: "acme",
      cookie: ownerCk,
    });
    const boardStations: Array<Record<string, unknown>> = boardOwner.body?.stations ?? [];
    check(
      "stations/board: 200, both stations present",
      boardOwner.status === 200 && boardStations.length === 2,
      `status ${boardOwner.status} count ${boardStations.length}`,
    );
    const boardGrouped = boardStations.find((s) => s.id === groupedStation!.id);
    const boardUngrouped = boardStations.find((s) => s.id === ungroupedStation!.id);
    check(
      "stations/board: grouped station carries its group name, no active session",
      boardGrouped?.stationGroupName === "Board Group" && boardGrouped?.activeSession === null,
      JSON.stringify(boardGrouped),
    );
    check(
      "stations/board: ungrouped station has a null group and no active session",
      boardUngrouped?.stationGroupId === null &&
        boardUngrouped?.stationGroupName === null &&
        boardUngrouped?.activeSession === null,
      JSON.stringify(boardUngrouped),
    );
    check(
      "stations/board: never leaks qrSecret/qrSecretVersion",
      boardStations.every((s) => !("qrSecret" in s) && !("qrSecretVersion" in s)),
      JSON.stringify(boardStations),
    );

    // Missing branchId → 400 (Zod validation).
    const boardMissingBranch = await req("GET", "/rpc/stations/board", { slug: "acme", cookie: ownerCk });
    check(
      "stations/board: missing branchId 400s",
      boardMissingBranch.status === 400,
      `status ${boardMissingBranch.status}`,
    );

    // Cross-tenant: contoso staff reading acme's branchId gets an EMPTY
    // array (RLS-scoped), never acme's rows and never a 404 — matches this
    // module's existing "empty, not 404" convention for a branchId filter.
    const boardContosoCk = await staffCookie("owner@contoso.test");
    const boardCrossTenant = await req("GET", `/rpc/stations/board?branchId=${boardBranch!.id}`, {
      slug: "contoso",
      cookie: boardContosoCk,
    });
    check(
      "stations/board: cross-tenant read returns an empty array, not acme's rows",
      boardCrossTenant.status === 200 && (boardCrossTenant.body?.stations ?? []).length === 0,
      `status ${boardCrossTenant.status} body ${JSON.stringify(boardCrossTenant.body)}`,
    );

    // Role gate: a portal/member cookie (not staff) is refused by
    // tenantMiddleware() before the handler runs, same as every other
    // /rpc/* route.
    const boardPortalCookie = await req("GET", `/rpc/stations/board?branchId=${boardBranch!.id}`, {
      slug: "acme",
      cookie: custCk,
    });
    check(
      "stations/board: portal/customer cookie refused on the staff route (401)",
      boardPortalCookie.status === 401,
      `status ${boardPortalCookie.status}`,
    );
  }

  // I. DB-level RLS proof: acme context cannot read contoso's row.
  const leak = await withTenant(acmeId, (tx) =>
    tx.select().from(project).where(eq(project.id, contosoProject!.id)),
  );
  check("RLS: acme cannot read contoso's project row", leak.length === 0, `got ${leak.length}`);

  // J. Audit log: the create+delete above emitted events the owner can read.
  const auditOwner = await req("GET", "/rpc/audit", { slug: "acme", cookie: ownerCk });
  const auditActions: string[] = (auditOwner.body?.items ?? []).map((e: any) => e.action);
  check("owner reads audit log (200)", auditOwner.status === 200, `status ${auditOwner.status}`);
  check(
    "audit includes project.created + project.deleted",
    auditActions.includes("project.created") && auditActions.includes("project.deleted"),
    auditActions.join(","),
  );
  check(
    "audit list is paginated (meta present)",
    typeof auditOwner.body?.meta?.totalItems === "number" && auditOwner.body.meta.totalItems >= 2,
    JSON.stringify(auditOwner.body?.meta),
  );

  // K. Role gate: a staff-role user cannot read the audit log.
  const auditStaff = await req("GET", "/rpc/audit", { slug: "acme", cookie: staffCk });
  check("staff role blocked from audit (403)", auditStaff.status === 403, `status ${auditStaff.status}`);

  // L. Cross-tenant isolation (HTTP): contoso owner sees none of acme's events.
  const contosoOwnerCk = await staffCookie("owner@contoso.test");
  const auditContoso = await req("GET", "/rpc/audit", { slug: "contoso", cookie: contosoOwnerCk });
  check(
    "contoso audit excludes acme's events",
    auditContoso.status === 200 && (auditContoso.body?.items ?? []).length === 0,
    `status ${auditContoso.status} items ${(auditContoso.body?.items ?? []).length}`,
  );

  // M. Cross-tenant isolation (DB/RLS): audit rows don't cross tenants.
  const acmeAudit = await withTenant(acmeId, (tx) => tx.select().from(auditEvent));
  const contosoAudit = await withTenant(contosoId, (tx) => tx.select().from(auditEvent));
  check("RLS: acme has its own audit rows", acmeAudit.length >= 2, `got ${acmeAudit.length}`);
  check("RLS: contoso cannot read acme's audit rows", contosoAudit.length === 0, `got ${contosoAudit.length}`);

  // N. White-label branding — happy path (admin write → read + public read).
  const brSet = await req("PUT", "/rpc/branding", {
    slug: "acme",
    cookie: ownerCk,
    json: {
      displayName: "Acme Brand",
      primaryColor: "#123abc",
      customCss: "body{}</style><script>alert(1)</script>",
    },
  });
  check(
    "owner sets branding (200)",
    brSet.status === 200 && brSet.body?.branding?.displayName === "Acme Brand",
    `status ${brSet.status} ${JSON.stringify(brSet.body?.branding)}`,
  );
  check(
    "custom CSS sanitized (no </style>/<script>)",
    typeof brSet.body?.branding?.customCss === "string" &&
      !/<\/?script|<\/style>/i.test(brSet.body.branding.customCss),
    JSON.stringify(brSet.body?.branding?.customCss),
  );
  const brGet = await req("GET", "/rpc/branding", { slug: "acme", cookie: ownerCk });
  check(
    "member reads branding back",
    brGet.status === 200 && brGet.body?.branding?.primaryColor === "#123abc",
    `status ${brGet.status}`,
  );
  const brPublic = await req("GET", "/public/branding", { slug: "acme" });
  check(
    "public/branding exposes name (pre-auth)",
    brPublic.status === 200 && brPublic.body?.branding?.displayName === "Acme Brand",
    `status ${brPublic.status} ${JSON.stringify(brPublic.body?.branding)}`,
  );

  // N2. Public venue info (tenant-white-label-site plan, Phase 1).
  // This is the offline proof for the new /public/venue-info route: the
  // browser-level Playwright spec cannot run without a live DB + dev server, so
  // the isolation case in particular is proven here instead.
  {
    const { chronoBranch } = await import("../modules/branch/schema");
    const { chronoStationGroup } = await import("../modules/station/schema");

    // Give contoso its own branch + rate so the cross-tenant assertion below is
    // NON-VACUOUS — comparing against an empty tenant would pass whether
    // isolation worked or not.
    const [contosoBranch] = await withTenant(contosoId, (tx) =>
      tx
        .insert(chronoBranch)
        .values({
          id: createId(),
          tenantId: contosoId,
          name: "Contoso Venue",
          code: "CTSVENUE",
          contactNumber: "+63 900 000 0002",
          googleMapsUrl: "https://maps.example.com/contoso",
        })
        .returning(),
    );
    await withTenant(contosoId, (tx) =>
      tx.insert(chronoStationGroup).values({
        id: createId(),
        tenantId: contosoId,
        branchId: contosoBranch!.id,
        name: "Contoso VIP",
        code: "CTSVIP",
        hourlyRate: "99.00",
      }),
    );

    const acmeVenue = await req("GET", "/public/venue-info", { slug: "acme" });
    check(
      "public/venue-info returns acme's own branch (200, pre-auth)",
      acmeVenue.status === 200 && typeof acmeVenue.body?.branch?.name === "string",
      `status ${acmeVenue.status} ${JSON.stringify(acmeVenue.body?.branch)}`,
    );

    const contosoVenue = await req("GET", "/public/venue-info", { slug: "contoso" });
    check(
      "public/venue-info returns contoso's own branch + rate",
      contosoVenue.status === 200 &&
        contosoVenue.body?.branch?.name === "Contoso Venue" &&
        contosoVenue.body?.rateGroups?.some(
          (g: { name: string; hourlyRate: string }) =>
            g.name === "Contoso VIP" && g.hourlyRate === "99.00",
        ),
      `status ${contosoVenue.status} ${JSON.stringify(contosoVenue.body)}`,
    );

    // THE isolation case: acme's response must carry nothing of contoso's.
    const acmeSerialized = JSON.stringify(acmeVenue.body ?? {});
    check(
      "public/venue-info: acme never sees contoso's branch or rates (isolation)",
      !acmeSerialized.includes("Contoso Venue") &&
        !acmeSerialized.includes("Contoso VIP") &&
        !acmeSerialized.includes("99.00"),
      acmeSerialized,
    );
    const contosoSerialized = JSON.stringify(contosoVenue.body ?? {});
    check(
      "public/venue-info: contoso never sees acme's branch (isolation, both ways)",
      !contosoSerialized.includes("Board Branch") && !contosoSerialized.includes("Main"),
      contosoSerialized,
    );

    // Never a raw row — the response is exactly the contract's shape.
    const venueKeys = Object.keys(acmeVenue.body ?? {}).sort().join(",");
    check(
      "public/venue-info returns only { branch, rateGroups } — no raw row",
      venueKeys === "branch,rateGroups",
      venueKeys,
    );
    const branchKeys = Object.keys(acmeVenue.body?.branch ?? {}).sort().join(",");
    check(
      "public/venue-info branch carries no id/tenantId/status/timestamps",
      !branchKeys.includes("tenantId") &&
        !branchKeys.includes("createdAt") &&
        !/(^|,)id(,|$)/.test(branchKeys),
      branchKeys,
    );

    const venueUnknown = await req("GET", "/public/venue-info", { slug: "no-such-tenant" });
    check(
      "public/venue-info 404s an unresolvable tenant",
      venueUnknown.status === 404,
      `status ${venueUnknown.status}`,
    );

    // Phase 1's third acceptance criterion: a tenant in a TERMINAL lifecycle
    // status must 404, not merely an unknown one. Proven on a throwaway org
    // (the `deleting-co` pattern further down) so no other block's tenant state
    // is disturbed: the SAME host is read active first, then flipped, so a
    // pass cannot come from the row simply not resolving.
    //
    // This also pins the gate ahead of the response cache — the active read
    // populates it, so a cache lookup placed before the status check would
    // serve the suspended tenant its own cached 200.
    const terminalOrgId = createId();
    const terminalSlug = `terminal-venue-${terminalOrgId.slice(0, 8)}`;
    await adminDb.insert(schema.organization).values({
      id: terminalOrgId,
      name: "Terminal Venue Co",
      slug: terminalSlug,
    });
    const terminalActive = await req("GET", "/public/venue-info", { slug: terminalSlug });
    check(
      "public/venue-info serves an ACTIVE tenant (control for the terminal case)",
      terminalActive.status === 200,
      `status ${terminalActive.status}`,
    );
    for (const status of ["suspended", "cancelled", "archived", "deleting"] as const) {
      await adminDb
        .update(schema.organization)
        .set({ status })
        .where(eq(schema.organization.id, terminalOrgId));
      const terminalRes = await req("GET", "/public/venue-info", { slug: terminalSlug });
      check(
        `public/venue-info 404s a "${status}" tenant`,
        terminalRes.status === 404,
        `status ${terminalRes.status}`,
      );
    }
    await adminDb
      .delete(schema.organization)
      .where(eq(schema.organization.id, terminalOrgId));
  }

  // O. Role gate: a staff-role user cannot write branding.
  const brStaff = await req("PUT", "/rpc/branding", {
    slug: "acme",
    cookie: staffCk,
    json: { displayName: "Hacked" },
  });
  check("staff role blocked from branding write (403)", brStaff.status === 403, `status ${brStaff.status}`);

  // P. Cross-tenant isolation (HTTP): contoso never sees acme's branding.
  const brContoso = await req("GET", "/rpc/branding", {
    slug: "contoso",
    cookie: contosoOwnerCk,
  });
  check(
    "contoso branding excludes acme's values",
    brContoso.status === 200 && brContoso.body?.branding?.displayName === null,
    `status ${brContoso.status} ${JSON.stringify(brContoso.body?.branding)}`,
  );

  // Q. Cross-tenant isolation (DB/RLS): branding rows don't cross tenants.
  const acmeBranding = await withTenant(acmeId, (tx) => tx.select().from(tenantBranding));
  const contosoBranding = await withTenant(contosoId, (tx) => tx.select().from(tenantBranding));
  check("RLS: acme has its own branding row", acmeBranding.length === 1, `got ${acmeBranding.length}`);
  check("RLS: contoso cannot read acme's branding row", contosoBranding.length === 0, `got ${contosoBranding.length}`);

  // ── FF. Feature flags — read defaults, admin toggle, validation, isolation ──
  const FLAG = "example.beta_dashboard";
  const ffDefault = await req("GET", "/rpc/features", { slug: "acme", cookie: ownerCk });
  const ffDefaultRow = (ffDefault.body?.features ?? []).find((f: any) => f.key === FLAG);
  check(
    "features list returns registry defaults (flag off)",
    ffDefault.status === 200 && ffDefaultRow?.enabled === false && ffDefaultRow?.default === false,
    `status ${ffDefault.status} ${JSON.stringify(ffDefaultRow)}`,
  );

  const ffSet = await req("PUT", "/rpc/features", {
    slug: "acme",
    cookie: ownerCk,
    json: { key: FLAG, enabled: true },
  });
  const ffSetRow = (ffSet.body?.features ?? []).find((f: any) => f.key === FLAG);
  check(
    "owner enables a feature flag (200, effective true)",
    ffSet.status === 200 && ffSetRow?.enabled === true,
    `status ${ffSet.status} ${JSON.stringify(ffSetRow)}`,
  );

  const ffGet = await req("GET", "/rpc/features", { slug: "acme", cookie: ownerCk });
  const ffGetRow = (ffGet.body?.features ?? []).find((f: any) => f.key === FLAG);
  check("feature override persists on re-read", ffGetRow?.enabled === true, JSON.stringify(ffGetRow));

  const ffUnknown = await req("PUT", "/rpc/features", {
    slug: "acme",
    cookie: ownerCk,
    json: { key: "nope.not_a_flag", enabled: true },
  });
  check("unknown flag key rejected (400)", ffUnknown.status === 400, `status ${ffUnknown.status}`);

  const ffStaff = await req("PUT", "/rpc/features", {
    slug: "acme",
    cookie: staffCk,
    json: { key: FLAG, enabled: false },
  });
  check("staff role blocked from toggling flags (403)", ffStaff.status === 403, `status ${ffStaff.status}`);

  // Cross-tenant isolation (HTTP): acme's override never affects contoso.
  const ffContoso = await req("GET", "/rpc/features", { slug: "contoso", cookie: contosoOwnerCk });
  const ffContosoRow = (ffContoso.body?.features ?? []).find((f: any) => f.key === FLAG);
  check(
    "contoso sees the default (unaffected by acme's override)",
    ffContoso.status === 200 && ffContosoRow?.enabled === false,
    `status ${ffContoso.status} ${JSON.stringify(ffContosoRow)}`,
  );

  // Cross-tenant isolation (DB/RLS): override rows don't cross tenants.
  const acmeFlags = await withTenant(acmeId, (tx) => tx.select().from(tenantFeatureFlag));
  const contosoFlags = await withTenant(contosoId, (tx) => tx.select().from(tenantFeatureFlag));
  check("RLS: acme has its own feature-flag override row", acmeFlags.length === 1, `got ${acmeFlags.length}`);
  check("RLS: contoso cannot read acme's feature-flag rows", contosoFlags.length === 0, `got ${contosoFlags.length}`);

  // R. Asset upload — happy (admin) + role gate (staff). Uses a minimal PNG
  //    (magic-byte sniff only reads the signature; the route never decodes).
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
  ]);
  async function uploadAsset(cookie: string) {
    const fd = new FormData();
    fd.append("file", new Blob([png], { type: "image/png" }), "logo.png");
    const res = await fetch(`${base}/rpc/branding/asset`, {
      method: "POST",
      headers: { "x-tenant-slug": "acme", cookie },
      body: fd,
    });
    const body = (await res.json().catch(() => null)) as { url?: string } | null;
    return { status: res.status, body };
  }
  const upOwner = await uploadAsset(ownerCk);
  check(
    "owner uploads branding asset (200 + url)",
    upOwner.status === 200 && typeof upOwner.body?.url === "string",
    `status ${upOwner.status} ${JSON.stringify(upOwner.body)}`,
  );
  const upStaff = await uploadAsset(staffCk);
  check("staff role blocked from asset upload (403)", upStaff.status === 403, `status ${upStaff.status}`);

  // ── S. Invitations: invite → accept → member appears; role gate; cross-tenant ──
  const inviteeCk = (await ensureStaff("invitee@acme.test", "Acme Invitee"), await staffCookie("invitee@acme.test"));

  const { result: inviteRes, tokens: inviteTokens } = await captureEmailLinks(() =>
    req("POST", "/rpc/invites", {
      slug: "acme",
      cookie: ownerCk,
      json: { email: "invitee@acme.test", role: "staff" },
    }),
  );
  check(
    "owner creates invite (201, emailSent)",
    inviteRes.status === 201 && inviteRes.body?.emailSent === true,
    `status ${inviteRes.status} ${JSON.stringify(inviteRes.body)}`,
  );
  const inviteToken = inviteTokens[0];
  check("invite email delivered a token link", typeof inviteToken === "string", inviteTokens.join(","));

  const staffInvite = await req("POST", "/rpc/invites", {
    slug: "acme",
    cookie: staffCk,
    json: { email: "nope@acme.test", role: "staff" },
  });
  check("staff role blocked from inviting (403)", staffInvite.status === 403, `status ${staffInvite.status}`);

  const acceptCross = await req("POST", "/api/accept-invite", {
    slug: "contoso",
    cookie: contosoOwnerCk,
    json: { token: inviteToken },
  });
  check("acme invite token rejected on contoso host (404)", acceptCross.status === 404, `status ${acceptCross.status}`);

  const accept = await req("POST", "/api/accept-invite", {
    slug: "acme",
    cookie: inviteeCk,
    json: { token: inviteToken },
  });
  check(
    "invitee accepts invite (200, role staff)",
    accept.status === 200 && accept.body?.role === "staff",
    `status ${accept.status} ${JSON.stringify(accept.body)}`,
  );

  const membersAfter = await req("GET", "/rpc/members", { slug: "acme", cookie: ownerCk });
  const invited = (membersAfter.body?.items ?? []).find(
    (m: any) => m.email === "invitee@acme.test",
  );
  check("invited user appears as an acme member with role", !!invited && invited.role === "staff", JSON.stringify(invited));

  const acceptReplay = await req("POST", "/api/accept-invite", {
    slug: "acme",
    cookie: inviteeCk,
    json: { token: inviteToken },
  });
  check("replayed invite token rejected (409)", acceptReplay.status === 409, `status ${acceptReplay.status}`);

  // ── T. Customer password reset: forgot → reset → sign in with new password ──
  const NEWPW = "BrandNewPw456!";
  const { tokens: resetTokens } = await captureEmailLinks(() =>
    req("POST", "/portal/auth/forgot", { slug: "acme", json: { email: "cust@acme.test" } }),
  );
  const resetToken = resetTokens[0];
  check("forgot delivered a reset token link", typeof resetToken === "string", resetTokens.join(","));

  const resetCross = await req("POST", "/portal/auth/reset", {
    slug: "contoso",
    json: { token: resetToken!, password: NEWPW },
  });
  check("acme reset token rejected on contoso host (400)", resetCross.status === 400, `status ${resetCross.status}`);

  const reset = await req("POST", "/portal/auth/reset", {
    slug: "acme",
    json: { token: resetToken!, password: NEWPW },
  });
  check("customer resets password (200)", reset.status === 200, `status ${reset.status}`);

  const signInNew = await req("POST", "/portal/auth/sign-in", {
    slug: "acme",
    json: { email: "cust@acme.test", password: NEWPW },
  });
  check("customer signs in with the new password (200)", signInNew.status === 200, `status ${signInNew.status}`);

  const signInOld = await req("POST", "/portal/auth/sign-in", {
    slug: "acme",
    json: { email: "cust@acme.test", password: PW },
  });
  check("old password no longer works (401)", signInOld.status === 401, `status ${signInOld.status}`);

  // ── U. API keys: create → authenticates /rpc; role gate; revoke; isolation ──
  const keyCreate = await req("POST", "/rpc/api-keys", {
    slug: "acme",
    cookie: ownerCk,
    json: { name: "E2E Key", role: "admin" },
  });
  const apiKeySecret = keyCreate.body?.apiKey?.secret as string | undefined;
  check(
    "owner creates api key (201 + one-time secret)",
    keyCreate.status === 201 && typeof apiKeySecret === "string" && apiKeySecret.startsWith("agora_"),
    `status ${keyCreate.status} ${JSON.stringify(keyCreate.body?.apiKey?.prefix)}`,
  );
  const keyId = keyCreate.body?.apiKey?.id as string;

  // List never leaks the secret or hash.
  const keyList = await req("GET", "/rpc/api-keys", { slug: "acme", cookie: ownerCk });
  const listedKey = (keyList.body?.keys ?? []).find((k: any) => k.id === keyId);
  check(
    "api key list shows the key without secret/hash",
    keyList.status === 200 &&
      !!listedKey &&
      listedKey.secret === undefined &&
      listedKey.keyHash === undefined &&
      typeof listedKey.prefix === "string",
    JSON.stringify(listedKey),
  );

  // The secret authenticates a /rpc call as the key's tenant + role (no cookie).
  const keyMe = await req("GET", "/rpc/me", { slug: "acme", bearer: apiKeySecret });
  check(
    "api key authenticates /rpc/me (acme + admin role)",
    keyMe.status === 200 &&
      keyMe.body?.tenantSlug === "acme" &&
      keyMe.body?.role === "admin" &&
      String(keyMe.body?.userId ?? "").startsWith("apikey:"),
    `status ${keyMe.status} ${JSON.stringify(keyMe.body)}`,
  );

  // Key's tenant is authoritative: presenting acme's key against contoso's host
  // still resolves to acme and can only ever read acme's rows (never contoso's).
  const keyCross = await req("GET", "/rpc/projects", {
    slug: "contoso",
    bearer: apiKeySecret,
  });
  const crossTenantIds: string[] = (keyCross.body?.items ?? []).map((p: any) => p.tenantId);
  check(
    "acme key ignores contoso host + cannot read contoso rows",
    keyCross.status === 200 &&
      crossTenantIds.length > 0 &&
      crossTenantIds.every((id) => id === acmeId),
    `status ${keyCross.status} ${crossTenantIds.join(",")}`,
  );

  // Malformed / unknown keys → 401.
  const badKey = await req("GET", "/rpc/me", { slug: "acme", bearer: "agora_acme_notarealkey" });
  check("unknown api key rejected (401)", badKey.status === 401, `status ${badKey.status}`);

  // Role gate: a staff-role user cannot create keys.
  const keyStaff = await req("POST", "/rpc/api-keys", {
    slug: "acme",
    cookie: staffCk,
    json: { name: "Nope", role: "admin" },
  });
  check("staff role blocked from creating api keys (403)", keyStaff.status === 403, `status ${keyStaff.status}`);

  // Revoke → the key immediately fails auth (401).
  const keyRevoke = await req("DELETE", `/rpc/api-keys/${keyId}`, { slug: "acme", cookie: ownerCk });
  check("owner revokes api key (200)", keyRevoke.status === 200, `status ${keyRevoke.status}`);
  const keyMeRevoked = await req("GET", "/rpc/me", { slug: "acme", bearer: apiKeySecret });
  check("revoked api key rejected (401)", keyMeRevoked.status === 401, `status ${keyMeRevoked.status}`);
  // ── U. Webhooks: register → event → signed delivery; SSRF; role gate; retry→disable; isolation ──
  const http = await import("node:http");

  // A stub receiver that records every inbound webhook POST.
  type Hit = { headers: Record<string, string>; body: string };
  const hits: Hit[] = [];
  const stub = http.createServer((rq, rs) => {
    const chunks: Buffer[] = [];
    rq.on("data", (c) => chunks.push(c as Buffer));
    rq.on("end", () => {
      hits.push({
        headers: rq.headers as Record<string, string>,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      rs.writeHead(200);
      rs.end("ok");
    });
  });
  const stubPort: number = await new Promise((resolve) => {
    stub.listen(0, "127.0.0.1", () =>
      resolve((stub.address() as { port: number }).port),
    );
  });
  const stubUrl = `http://127.0.0.1:${stubPort}/hook`;

  // A port with nothing listening → deliveries there fail (connection refused).
  const deadPort: number = await new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
  const deadUrl = `http://127.0.0.1:${deadPort}/hook`;

  // Register a good endpoint (admin) subscribed to project.created.
  const whCreate = await req("POST", "/rpc/webhooks", {
    slug: "acme",
    cookie: ownerCk,
    json: { url: stubUrl, events: ["project.created"] },
  });
  check(
    "owner registers webhook (201 + secret revealed once)",
    whCreate.status === 201 &&
      typeof whCreate.body?.secret === "string" &&
      whCreate.body.secret.length > 0 &&
      whCreate.body?.endpoint?.secret === undefined,
    `status ${whCreate.status} ${JSON.stringify(whCreate.body?.endpoint)}`,
  );
  const whSecret = whCreate.body?.secret as string;
  const whId = whCreate.body?.endpoint?.id as string;

  // List never leaks the secret.
  const whList = await req("GET", "/rpc/webhooks", { slug: "acme", cookie: ownerCk });
  check(
    "webhook list omits secret",
    whList.status === 200 &&
      (whList.body?.endpoints ?? []).every(
        (e: any) => e.secret === undefined && typeof e.url === "string",
      ),
    `status ${whList.status}`,
  );

  // SSRF: non-https and private targets are rejected at create time (400).
  const whHttp = await req("POST", "/rpc/webhooks", {
    slug: "acme",
    cookie: ownerCk,
    json: { url: "http://example.com/hook", events: ["project.created"] },
  });
  check("webhook rejects non-https (400)", whHttp.status === 400, `status ${whHttp.status}`);
  const whPrivate = await req("POST", "/rpc/webhooks", {
    slug: "acme",
    cookie: ownerCk,
    json: { url: "https://10.0.0.5/hook", events: ["project.created"] },
  });
  check("webhook rejects private IP (400)", whPrivate.status === 400, `status ${whPrivate.status}`);
  const whLocalhost = await req("POST", "/rpc/webhooks", {
    slug: "acme",
    cookie: ownerCk,
    json: { url: "https://localhost/hook", events: ["project.created"] },
  });
  check("webhook rejects localhost (400)", whLocalhost.status === 400, `status ${whLocalhost.status}`);

  // Role gate: a staff-role user cannot manage webhooks.
  const whStaffPost = await req("POST", "/rpc/webhooks", {
    slug: "acme",
    cookie: staffCk,
    json: { url: stubUrl, events: ["project.created"] },
  });
  check("staff role blocked from registering webhook (403)", whStaffPost.status === 403, `status ${whStaffPost.status}`);
  const whStaffGet = await req("GET", "/rpc/webhooks", { slug: "acme", cookie: staffCk });
  check("staff role blocked from listing webhooks (403)", whStaffGet.status === 403, `status ${whStaffGet.status}`);

  // Trigger an event, then drain the worker once.
  const whProj = await req("POST", "/rpc/projects", {
    slug: "acme",
    cookie: ownerCk,
    json: { name: "Webhook Project" },
  });
  check("project create for webhook (201)", whProj.status === 201, `status ${whProj.status}`);
  await runQueueOnce("webhooks");

  check("webhook delivered a signed POST to the stub", hits.length === 1, `hits ${hits.length}`);
  const hit = hits[0];
  const sigHeader = hit?.headers["x-agora-signature"] ?? "";
  check(
    "delivery signature verifies with the endpoint secret",
    !!hit && verifyWebhookSignature(whSecret, hit.body, sigHeader),
    `sig ${sigHeader}`,
  );
  check(
    "delivery carries event + delivery id headers",
    hit?.headers["x-agora-event"] === "project.created" &&
      typeof hit?.headers["x-agora-delivery-id"] === "string",
    JSON.stringify({ ev: hit?.headers["x-agora-event"], id: hit?.headers["x-agora-delivery-id"] }),
  );
  check(
    "delivery payload wraps the event data",
    (() => {
      try {
        const b = JSON.parse(hit!.body);
        return b.event === "project.created" && b.data?.name === "Webhook Project";
      } catch {
        return false;
      }
    })(),
    hit?.body,
  );

  // Delivery log shows the success (admin).
  const whDeliveries = await req("GET", `/rpc/webhooks/${whId}/deliveries`, {
    slug: "acme",
    cookie: ownerCk,
  });
  check(
    "delivery log records success (200 + status success)",
    whDeliveries.status === 200 &&
      (whDeliveries.body?.items ?? []).some(
        (d: any) => d.status === "success" && d.responseCode === 200 && d.attempts >= 1,
      ),
    JSON.stringify(whDeliveries.body?.items),
  );

  // Failing endpoint retries then auto-disables.
  const [deadEp] = await withTenant(acmeId, (tx) =>
    tx
      .insert(webhookEndpoint)
      .values({
        id: createId(),
        tenantId: acmeId,
        url: deadUrl,
        secret: "whsec_dead",
        events: ["project.created"],
      })
      .returning(),
  );
  await req("POST", "/rpc/projects", {
    slug: "acme",
    cookie: ownerCk,
    json: { name: "Doomed Delivery" },
  });
  // Drain repeatedly; backoff is ~1ms so due rows reappear each tick.
  for (let i = 0; i < 10; i++) {
    await runQueueOnce("webhooks");
    await new Promise((r) => setTimeout(r, 5));
  }
  const [deadEpAfter] = await withTenant(acmeId, (tx) =>
    tx.select().from(webhookEndpoint).where(eq(webhookEndpoint.id, deadEp!.id)),
  );
  check(
    "failing endpoint is auto-disabled after threshold",
    !!deadEpAfter && deadEpAfter.enabled === false && deadEpAfter.disabledAt !== null,
    `enabled ${deadEpAfter?.enabled} failures ${deadEpAfter?.consecutiveFailures}`,
  );
  const deadDeliveries = await withAdmin((tx: import("agora/db").TenantTx) =>
    tx
      .select()
      .from(job)
      .where(
        and(
          eq(job.tenantId, acmeId),
          eq(job.queue, "webhooks"),
          eq(job.type, "deliver-webhook"),
          sql`${job.payload}->>'endpointId' = ${deadEp!.id}`
        )
      )
  );
  check(
    "failed delivery ends in failed status",
    deadDeliveries.length === 1 && deadDeliveries[0]?.status === "failed",
    JSON.stringify(deadDeliveries.map((d: any) => ({ s: d.status, a: d.attempts }))),
  );

  // Cross-tenant: a contoso endpoint on the same event never receives acme's.
  const whContoso = await req("POST", "/rpc/webhooks", {
    slug: "contoso",
    cookie: contosoOwnerCk,
    json: { url: stubUrl, events: ["project.created"] },
  });
  check("contoso registers its own webhook (201)", whContoso.status === 201, `status ${whContoso.status}`);
  const contosoWhId = whContoso.body?.endpoint?.id as string;
  hits.length = 0;
  // An acme event fires + drains; contoso's endpoint must get nothing.
  await req("POST", "/rpc/projects", {
    slug: "acme",
    cookie: ownerCk,
    json: { name: "Acme Only Event" },
  });
  await runQueueOnce("webhooks");
  const contosoDeliveries = await withAdmin((tx: import("agora/db").TenantTx) =>
    tx
      .select()
      .from(job)
      .where(
        and(
          eq(job.tenantId, contosoId),
          eq(job.queue, "webhooks"),
          eq(job.type, "deliver-webhook"),
          sql`${job.payload}->>'endpointId' = ${contosoWhId}`
        )
      )
  );
  check(
    "contoso endpoint receives none of acme's events (RLS)",
    contosoDeliveries.length === 0,
    `got ${contosoDeliveries.length}`,
  );
  // HTTP isolation: contoso cannot read acme's endpoint deliveries.
  const crossLog = await req("GET", `/rpc/webhooks/${whId}/deliveries`, {
    slug: "contoso",
    cookie: contosoOwnerCk,
  });
  check(
    "contoso cannot see acme endpoint deliveries (empty)",
    crossLog.status === 200 && (crossLog.body?.items ?? []).length === 0,
    `status ${crossLog.status} items ${(crossLog.body?.items ?? []).length}`,
  );
  // And acme's endpoint is not visible in contoso's list.
  const contosoList = await req("GET", "/rpc/webhooks", { slug: "contoso", cookie: contosoOwnerCk });
  check(
    "contoso webhook list excludes acme's endpoint",
    contosoList.status === 200 &&
      !(contosoList.body?.endpoints ?? []).some((e: any) => e.id === whId),
    `status ${contosoList.status}`,
  );

  await new Promise<void>((r) => stub.close(() => r()));
  // ── U. Custom domains: add → verify (DNS) → routes; role gate; claim; isolation ──
  // Mock DNS with an in-memory zone so verify runs offline + deterministically.
  const dnsTxt = new Map<string, string[]>();
  const dnsCname = new Map<string, string[]>();
  const notFound = () => {
    const e = new Error("ENOTFOUND") as Error & { code: string };
    e.code = "ENOTFOUND";
    throw e;
  };
  setDnsResolver({
    resolveTxt: async (h: string) => {
      const v = dnsTxt.get(h.toLowerCase());
      if (!v) return notFound();
      return v.map((s) => [s]);
    },
    resolveCname: async (h: string) => {
      const v = dnsCname.get(h.toLowerCase());
      if (!v) return notFound();
      return v;
    },
  });

  const CUSTOM_HOST = "app.acme-e2e.test";

  // Custom domains are a plan-gated feature (see the Billing block). Entitle acme
  // with a pro subscription for this block, then remove it afterwards so the
  // Billing block still starts from the free-plan default.
  await withTenant(acmeId, (tx) =>
    tx.insert(tenantSubscription).values({
      id: createId(),
      tenantId: acmeId,
      plan: "pro",
      status: "active",
      seats: 20,
    }),
  );

  // Add (owner) → 201 + a TXT record to create.
  const domAdd = await req("POST", "/rpc/domains", {
    slug: "acme",
    cookie: ownerCk,
    json: { hostname: CUSTOM_HOST, method: "txt" },
  });
  check(
    "owner adds custom domain (201 + DNS record)",
    domAdd.status === 201 &&
      domAdd.body?.domain?.hostname === CUSTOM_HOST &&
      domAdd.body?.domain?.verifiedAt === null &&
      domAdd.body?.domain?.record?.type === "TXT",
    `status ${domAdd.status} ${JSON.stringify(domAdd.body?.domain)}`,
  );
  const domId = domAdd.body?.domain?.id as string;
  const txtName = domAdd.body?.domain?.record?.name as string;
  const txtValue = domAdd.body?.domain?.record?.value as string;

  // Role gate: staff cannot add or verify.
  const domAddStaff = await req("POST", "/rpc/domains", {
    slug: "acme",
    cookie: staffCk,
    json: { hostname: "nope.acme-e2e.test", method: "txt" },
  });
  check("staff role blocked from adding domain (403)", domAddStaff.status === 403, `status ${domAddStaff.status}`);
  const domVerifyStaff = await req("POST", `/rpc/domains/${domId}/verify`, { slug: "acme", cookie: staffCk });
  check("staff role blocked from verifying domain (403)", domVerifyStaff.status === 403, `status ${domVerifyStaff.status}`);

  // Verify with the record ABSENT → stays pending; host does NOT route yet.
  const domVerifyMissing = await req("POST", `/rpc/domains/${domId}/verify`, { slug: "acme", cookie: ownerCk });
  check(
    "verify with missing DNS record stays pending",
    domVerifyMissing.status === 200 &&
      domVerifyMissing.body?.verified === false &&
      domVerifyMissing.body?.domain?.verifiedAt === null,
    `status ${domVerifyMissing.status} ${JSON.stringify(domVerifyMissing.body)}`,
  );
  const routePending = await req("GET", "/public/tenant", { host: CUSTOM_HOST });
  check("unverified custom host does not route (404)", routePending.status === 404, `status ${routePending.status}`);

  // Publish the TXT record, then verify → verified + host routes to acme.
  dnsTxt.set(txtName, [txtValue]);
  const domVerifyOk = await req("POST", `/rpc/domains/${domId}/verify`, { slug: "acme", cookie: ownerCk });
  check(
    "verify with present DNS record succeeds (verifiedAt set)",
    domVerifyOk.status === 200 &&
      domVerifyOk.body?.verified === true &&
      typeof domVerifyOk.body?.domain?.verifiedAt === "string",
    `status ${domVerifyOk.status} ${JSON.stringify(domVerifyOk.body)}`,
  );
  const routeVerified = await req("GET", "/public/tenant", { host: CUSTOM_HOST });
  check(
    "verified custom host routes to acme",
    routeVerified.status === 200 && routeVerified.body?.tenant?.slug === "acme",
    `status ${routeVerified.status} ${JSON.stringify(routeVerified.body)}`,
  );

  // Claim collision: contoso cannot add the host acme already holds.
  const domClaim = await req("POST", "/rpc/domains", {
    slug: "contoso",
    cookie: contosoOwnerCk,
    json: { hostname: CUSTOM_HOST, method: "txt" },
  });
  check("claiming another business's domain rejected (409)", domClaim.status === 409, `status ${domClaim.status}`);

  // Reject adding the app's own domain as a custom domain.
  const domApex = await req("POST", "/rpc/domains", {
    slug: "acme",
    cookie: ownerCk,
    json: { hostname: "sub.localtest.me", method: "txt" },
  });
  check("adding a host under APP_DOMAIN rejected (400)", domApex.status === 400, `status ${domApex.status}`);

  // Cross-tenant isolation (HTTP): contoso sees none of acme's domains.
  const domListContoso = await req("GET", "/rpc/domains", { slug: "contoso", cookie: contosoOwnerCk });
  check(
    "contoso domain list excludes acme's domain",
    domListContoso.status === 200 && (domListContoso.body?.domains ?? []).length === 0,
    `status ${domListContoso.status} items ${(domListContoso.body?.domains ?? []).length}`,
  );

  // Cross-tenant isolation (DB/RLS): domain rows don't cross tenants.
  const acmeDomains = await withTenant(acmeId, (tx) => tx.select().from(domain));
  const contosoDomains = await withTenant(contosoId, (tx) => tx.select().from(domain));
  check("RLS: acme has its own domain row", acmeDomains.length === 1, `got ${acmeDomains.length}`);
  check("RLS: contoso cannot read acme's domain row", contosoDomains.length === 0, `got ${contosoDomains.length}`);

  // Recheck job: drop the DNS record → recheck deactivates the domain (stops routing).
  dnsTxt.delete(txtName);
  const recheckUnauth = await req("POST", "/internal/domains/recheck", {});
  check("recheck without token rejected (401)", recheckUnauth.status === 401, `status ${recheckUnauth.status}`);
  const recheck = await req("POST", "/internal/domains/recheck", {
    headers: { "x-internal-token": "e2e-internal-token" },
  });
  check(
    "recheck deactivates a domain whose DNS record vanished",
    recheck.status === 200 && recheck.body?.deactivated >= 1,
    `status ${recheck.status} ${JSON.stringify(recheck.body)}`,
  );
  const routeAfterRecheck = await req("GET", "/public/tenant", { host: CUSTOM_HOST });
  check("deactivated custom host no longer routes (404)", routeAfterRecheck.status === 404, `status ${routeAfterRecheck.status}`);

  // Remove (owner) → row gone.
  const domDelete = await req("DELETE", `/rpc/domains/${domId}`, { slug: "acme", cookie: ownerCk });
  check("owner removes domain (200)", domDelete.status === 200, `status ${domDelete.status}`);
  const domListAfter = await req("GET", "/rpc/domains", { slug: "acme", cookie: ownerCk });
  check("removed domain gone from list", (domListAfter.body?.domains ?? []).length === 0, `items ${(domListAfter.body?.domains ?? []).length}`);

  // Remove the pro subscription seeded for the domains block so the Billing
  // block below starts from acme's free-plan default.
  await withTenant(acmeId, (tx) => tx.delete(tenantSubscription));

  // ── U. Billing: entitlements, seat cap, signed webhook sync, isolation ──
  // Role gate: billing read is admin+, checkout is owner-only.
  const billStaff = await req("GET", "/rpc/billing", { slug: "acme", cookie: staffCk });
  check("staff role blocked from billing read (403)", billStaff.status === 403, `status ${billStaff.status}`);
  const checkoutStaff = await req("POST", "/rpc/billing/checkout", {
    slug: "acme",
    cookie: staffCk,
    json: { plan: "pro" },
  });
  check("non-owner blocked from checkout (403)", checkoutStaff.status === 403, `status ${checkoutStaff.status}`);

  // Default (no subscription row) → free plan, custom domains excluded.
  const billFree = await req("GET", "/rpc/billing", { slug: "acme", cookie: ownerCk });
  check(
    "acme defaults to free plan",
    billFree.status === 200 &&
      billFree.body?.subscription?.plan === "free" &&
      billFree.body?.subscription?.entitlements?.customDomains === false,
    `status ${billFree.status} ${JSON.stringify(billFree.body?.subscription)}`,
  );

  // Entitlement gate on free: custom domains are blocked (402).
  const domainFree = await req("POST", "/rpc/domains", {
    slug: "acme",
    cookie: ownerCk,
    json: { hostname: "billing-test.example.com" },
  });
  check("custom domain blocked on free plan (402)", domainFree.status === 402, `status ${domainFree.status}`);

  // Seat cap on free: acme has 3 staff (owner+staff+invitee) = free cap → 402.
  const seatBlocked = await req("POST", "/rpc/invites", {
    slug: "acme",
    cookie: ownerCk,
    json: { email: "seat4@acme.test", role: "staff" },
  });
  check("invite blocked at free seat cap (402)", seatBlocked.status === 402, `status ${seatBlocked.status}`);

  // Webhook with a bad signature is rejected.
  const badHook = await fetch(`${base}/billing/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": "t=1,v1=deadbeef" },
    body: JSON.stringify({ id: "evt_bad", type: "checkout.session.completed", data: { object: {} } }),
  });
  check("webhook rejects bad signature (400)", badHook.status === 400, `status ${badHook.status}`);

  // Signed webhook flips acme to pro (checkout.session.completed).
  const evt = {
    id: "evt_e2e_acme_1",
    type: "checkout.session.completed",
    data: {
      object: {
        customer: "cus_e2e_acme",
        subscription: "sub_e2e_acme",
        client_reference_id: acmeId,
        metadata: { tenantId: acmeId, plan: "pro" },
      },
    },
  };
  const evtPayload = JSON.stringify(evt);
  const sig = signStripePayload(evtPayload, "whsec_e2e_test_secret");
  async function postHook(payload: string, signature: string) {
    const res = await fetch(`${base}/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body: payload,
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  }
  const hook1 = await postHook(evtPayload, sig);
  check("signed webhook accepted (200)", hook1.status === 200 && hook1.body?.received === true, `status ${hook1.status} ${JSON.stringify(hook1.body)}`);

  const billPro = await req("GET", "/rpc/billing", { slug: "acme", cookie: ownerCk });
  check(
    "webhook upgraded acme to pro (active, seats 20, custom domains)",
    billPro.status === 200 &&
      billPro.body?.subscription?.plan === "pro" &&
      billPro.body?.subscription?.status === "active" &&
      billPro.body?.subscription?.seats === 20 &&
      billPro.body?.subscription?.entitlements?.customDomains === true,
    `status ${billPro.status} ${JSON.stringify(billPro.body?.subscription)}`,
  );

  // Idempotency: replaying the same event id is a no-op (still pro).
  const hook2 = await postHook(evtPayload, sig);
  check("duplicate webhook is idempotent (200)", hook2.status === 200, `status ${hook2.status}`);
  const billProAgain = await req("GET", "/rpc/billing", { slug: "acme", cookie: ownerCk });
  check("replay left plan unchanged (pro)", billProAgain.body?.subscription?.plan === "pro", JSON.stringify(billProAgain.body?.subscription));

  // Org-lifecycle mirror (Phase 1): the active-status webhook mirrors
  // organization.status → "active" in the same withAdmin callback as the
  // subscription upsert (never overwriting an admin block).
  const [acmeOrgAfterHook] = await adminDb
    .select({ status: schema.organization.status })
    .from(schema.organization)
    .where(eq(schema.organization.id, acmeId));
  check(
    "webhook mirrors active subscription onto organization.status",
    acmeOrgAfterHook?.status === "active",
    `org.status ${acmeOrgAfterHook?.status}`,
  );

  // ── U0. tenantSubscriptionEvent history (Phase 2): a real plan/status
  // change writes exactly one history row with correct previous/new values;
  // a redelivered/no-op webhook event writes none. ──
  const acmeEventsAfterUpgrade = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantSubscriptionEvent).where(eq(tenantSubscriptionEvent.tenantId, acmeId)),
  );
  // acme's subscription row was deleted just above (line ~1190) so this
  // webhook's upsert takes the no-conflict INSERT path — first-ever row for
  // this tenant, so previousPlan/previousStatus are null (the documented
  // "null on first-ever row" convention), not "free".
  check(
    "real (null→pro) webhook change writes exactly one history row",
    acmeEventsAfterUpgrade.length === 1 &&
      acmeEventsAfterUpgrade[0]?.previousPlan === null &&
      acmeEventsAfterUpgrade[0]?.newPlan === "pro" &&
      acmeEventsAfterUpgrade[0]?.source === "webhook",
    `got ${JSON.stringify(acmeEventsAfterUpgrade)}`,
  );
  const acmeEventsAfterReplay = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantSubscriptionEvent).where(eq(tenantSubscriptionEvent.tenantId, acmeId)),
  );
  check(
    "redelivered/no-op webhook event writes no new history row",
    acmeEventsAfterReplay.length === 1,
    `got ${acmeEventsAfterReplay.length}`,
  );

  // Entitlement + seat cap now lifted on pro.
  const domainPro = await req("POST", "/rpc/domains", {
    slug: "acme",
    cookie: ownerCk,
    json: { hostname: "billing-test.example.com" },
  });
  check("custom domain allowed on pro plan (201)", domainPro.status === 201, `status ${domainPro.status}`);
  const seatAllowed = await req("POST", "/rpc/invites", {
    slug: "acme",
    cookie: ownerCk,
    json: { email: "seat4@acme.test", role: "staff" },
  });
  check("invite allowed after upgrade (201)", seatAllowed.status === 201, `status ${seatAllowed.status}`);

  // HTTP isolation: contoso still sees its own (free) subscription, not acme's pro.
  const billContoso = await req("GET", "/rpc/billing", { slug: "contoso", cookie: contosoOwnerCk });
  check(
    "contoso billing is its own free plan (isolation)",
    billContoso.status === 200 && billContoso.body?.subscription?.plan === "free",
    `status ${billContoso.status} ${JSON.stringify(billContoso.body?.subscription)}`,
  );

  // DB/RLS isolation: acme has its subscription row; contoso cannot read it.
  const acmeSub = await withTenant(acmeId, (tx) => tx.select().from(tenantSubscription));
  const contosoSub = await withTenant(contosoId, (tx) => tx.select().from(tenantSubscription));
  check("RLS: acme has its own subscription row", acmeSub.length === 1 && acmeSub[0]?.plan === "pro", `got ${acmeSub.length}`);
  check("RLS: contoso cannot read acme's subscription row", contosoSub.length === 0, `got ${contosoSub.length}`);
  check("billing row records payment_provider (default stripe)", acmeSub[0]?.paymentProvider === "stripe", `got ${acmeSub[0]?.paymentProvider}`);

  // ── U'. Xendit billing provider: provider-neutral verify/parse (pure, no HTTP) ──
  // The webhook provider is decoupled from the API key, so these exercise the
  // Xendit provider's token verification and invoice→subscription mapping directly.
  const xnd = getBillingWebhookProvider("xendit");
  const XND_TOKEN = "xnd_e2e_callback_token";
  check(
    "xendit verifyWebhook accepts matching x-callback-token",
    xnd.verifyWebhook({ payload: "{}", header: XND_TOKEN, secret: XND_TOKEN }) === true,
  );
  check(
    "xendit verifyWebhook rejects a wrong token",
    xnd.verifyWebhook({ payload: "{}", header: "wrong-token", secret: XND_TOKEN }) === false,
  );
  check(
    "xendit verifyWebhook rejects a missing token header",
    xnd.verifyWebhook({ payload: "{}", header: null, secret: XND_TOKEN }) === false,
  );
  const xndPaid = xnd.parseEvent(
    JSON.stringify({
      id: "inv_e2e_paid",
      status: "PAID",
      external_id: "tnt_e2e",
      metadata: { tenantId: "tnt_e2e", plan: "pro" },
    }),
  );
  check(
    "xendit parseEvent PAID → active pro (tenant + invoice id mapped)",
    !!xndPaid &&
      xndPaid.status === "active" &&
      xndPaid.canceled === false &&
      xndPaid.plan === "pro" &&
      xndPaid.tenantId === "tnt_e2e" &&
      xndPaid.stripeSubscriptionId === "inv_e2e_paid",
    JSON.stringify(xndPaid),
  );
  const xndExpired = xnd.parseEvent(
    JSON.stringify({ id: "inv_e2e_exp", status: "EXPIRED", external_id: "tnt_e2e2", metadata: {} }),
  );
  check(
    "xendit parseEvent EXPIRED → canceled (tenant from external_id)",
    !!xndExpired &&
      xndExpired.status === "canceled" &&
      xndExpired.canceled === true &&
      xndExpired.tenantId === "tnt_e2e2",
    JSON.stringify(xndExpired),
  );
  check(
    "xendit parseEvent ignores a non-terminal status (null)",
    xnd.parseEvent(JSON.stringify({ id: "inv_e2e_pending", status: "PENDING" })) === null,
  );
  // ── U. Observability: logging redaction, rate limiter, /metrics, safe boot ──
  const {
    createLogger,
    createRateLimiter,
    initObservability,
    captureError,
  } = await import("agora/server");

  // U1. Structured log redaction: secrets never reach the log stream.
  const captured: string[] = [];
  const testLog = createLogger({ level: "debug", write: (line) => captured.push(line) });
  testLog.info({
    authorization: "Bearer super-secret-token-value",
    cookie: "session=abc123def",
    nested: { password: "hunter2", token: "t0k3n-xyz" },
    msg: "sensitive line",
  });
  const logOut = captured.join("\n");
  check(
    "log output redacts authorization/cookie/password/token",
    logOut.includes("[REDACTED]") &&
      !logOut.includes("super-secret-token-value") &&
      !logOut.includes("session=abc123def") &&
      !logOut.includes("hunter2") &&
      !logOut.includes("t0k3n-xyz"),
    logOut,
  );

  // U2. Rate limiter (in-memory backend, no REDIS env) blocks after N attempts.
  const rl = createRateLimiter(2, 60_000, "e2e-ratelimit");
  const rlKey = "e2e-key";
  const before = await rl.blockedFor(rlKey);
  await rl.record(rlKey);
  await rl.record(rlKey);
  const after = await rl.blockedFor(rlKey);
  await rl.clear(rlKey);
  const cleared = await rl.blockedFor(rlKey);
  check(
    "rate limiter: unblocked → blocked after N → cleared",
    before === null && typeof after === "number" && after! > 0 && cleared === null,
    `before=${before} after=${after} cleared=${cleared}`,
  );

  // U3. /metrics returns Prometheus text exposition with our series, no tenant leak.
  const metricsRes = await fetch(`${base}/metrics`);
  const metricsText = await metricsRes.text();
  const metricsCt = metricsRes.headers.get("content-type") ?? "";
  check(
    "/metrics returns Prometheus text (counter + histogram)",
    metricsRes.status === 200 &&
      metricsCt.includes("text/plain") &&
      metricsText.includes("http_requests_total") &&
      metricsText.includes("# TYPE http_request_duration_seconds histogram"),
    `status ${metricsRes.status} ct=${metricsCt}`,
  );
  check(
    "/metrics does not label series by tenant id",
    !metricsText.includes(acmeId) &&
      !metricsText.includes(contosoId) &&
      !/tenant_?id/i.test(metricsText),
    "tenant identifier found in metrics output",
  );

  // U4. Correlation id: response echoes an x-request-id header.
  const idRes = await fetch(`${base}/health`);
  check(
    "response carries an x-request-id header",
    typeof idRes.headers.get("x-request-id") === "string" &&
      (idRes.headers.get("x-request-id") ?? "").length > 0,
    `x-request-id=${idRes.headers.get("x-request-id")}`,
  );

  // U5. Boots with all obs env unset: init + captureError never throw (no-op).
  let obsSafe = true;
  try {
    await initObservability();
    captureError(new Error("e2e-noop"), { requestId: "e2e" });
  } catch {
    obsSafe = false;
  }
  check("observability init + captureError no-op safely when unconfigured", obsSafe);

  // ── U. Security policy: CRUD + role gate + cross-tenant isolation ──
  const polGet = await req("GET", "/rpc/security/policy", { slug: "acme", cookie: ownerCk });
  check(
    "owner reads security policy (defaults)",
    polGet.status === 200 && polGet.body?.policy?.mfaRequired === false && polGet.body?.policy?.ssoRequired === false,
    `status ${polGet.status} ${JSON.stringify(polGet.body?.policy)}`,
  );
  const polStaff = await req("PUT", "/rpc/security/policy", {
    slug: "acme",
    cookie: staffCk,
    json: { mfaRequired: true },
  });
  check("staff role blocked from policy write (403)", polStaff.status === 403, `status ${polStaff.status}`);

  // ── V. SSO connection: create (secret encrypted, never returned) + isolation ──
  const ssoCreate = await req("PUT", "/rpc/security/sso", {
    slug: "acme",
    cookie: ownerCk,
    json: {
      issuer: "https://acme.okta.test",
      clientId: "acme-client",
      clientSecret: "super-secret-value",
      allowedDomain: "acme.test",
      defaultRole: "staff",
      enabled: true,
    },
  });
  check(
    "owner creates SSO connection (200)",
    ssoCreate.status === 200 && ssoCreate.body?.connection?.issuer === "https://acme.okta.test",
    `status ${ssoCreate.status} ${JSON.stringify(ssoCreate.body)}`,
  );
  check(
    "SSO client secret is NEVER returned",
    ssoCreate.body?.connection?.hasClientSecret === true &&
      !JSON.stringify(ssoCreate.body).includes("super-secret-value"),
    JSON.stringify(ssoCreate.body?.connection),
  );
  const ssoStaff = await req("PUT", "/rpc/security/sso", {
    slug: "acme",
    cookie: staffCk,
    json: { issuer: "https://x.test", clientId: "x", clientSecret: "y", enabled: true },
  });
  check("staff role blocked from SSO write (403)", ssoStaff.status === 403, `status ${ssoStaff.status}`);

  const ssoContoso = await req("GET", "/rpc/security/sso", { slug: "contoso", cookie: contosoOwnerCk });
  check(
    "contoso cannot read acme's SSO connection",
    ssoContoso.status === 200 && ssoContoso.body?.connection === null,
    `status ${ssoContoso.status} ${JSON.stringify(ssoContoso.body)}`,
  );
  // DB/RLS: acme has its row, contoso sees none.
  const acmeSso = await withTenant(acmeId, (tx) => tx.select().from(tenantSsoConnection));
  const contosoSso = await withTenant(contosoId, (tx) => tx.select().from(tenantSsoConnection));
  check("RLS: acme has its own SSO row", acmeSso.length === 1, `got ${acmeSso.length}`);
  check("RLS: contoso cannot read acme's SSO row", contosoSso.length === 0, `got ${contosoSso.length}`);

  // Public SSO hint reflects the enabled connection (pre-auth, no secret).
  const ssoHint = await req("GET", "/public/sso", { slug: "acme" });
  check(
    "public/sso reports enabled for acme",
    ssoHint.status === 200 && ssoHint.body?.sso?.enabled === true,
    JSON.stringify(ssoHint.body),
  );

  // ── W. MFA: real TOTP enroll → verify (deterministic) via Better Auth ──
  const mfaUser = (await ensureStaff("mfa@acme.test", "Acme MFA"));
  await addMember(acmeId, mfaUser, "staff");
  let mfaCk = await staffCookie("mfa@acme.test");
  const enable = await req("POST", "/api/auth/two-factor/enable", {
    slug: "acme",
    cookie: mfaCk,
    json: { password: PW },
  });
  if (enable.setCookie.length) mfaCk = jar(enable.setCookie);
  const totpUri: string | undefined = enable.body?.totpURI;
  check(
    "two-factor enable returns a totp uri + backup codes",
    enable.status === 200 && typeof totpUri === "string" && Array.isArray(enable.body?.backupCodes),
    `status ${enable.status} ${JSON.stringify(enable.body)}`,
  );
  const secret = totpUri ? new URL(totpUri).searchParams.get("secret") : null;
  const verifyTotp = await req("POST", "/api/auth/two-factor/verify-totp", {
    slug: "acme",
    cookie: mfaCk,
    json: { code: totp(secret ?? "") },
  });
  check("two-factor verify-totp succeeds with a computed code", verifyTotp.status === 200, `status ${verifyTotp.status} ${JSON.stringify(verifyTotp.body)}`);
  // verify-totp completes the 2FA login and rotates the session cookie — carry
  // the fresh cookie forward for the enrolled-user assertions below.
  if (verifyTotp.setCookie.length) mfaCk = jar(verifyTotp.setCookie);
  const mfaStatus = await req("GET", "/rpc/security/mfa", { slug: "acme", cookie: mfaCk });
  check("enrolled user reports mfa enrolled", mfaStatus.status === 200 && mfaStatus.body?.enrolled === true, JSON.stringify(mfaStatus.body));

  // ── X. mfaRequired enforcement: unenrolled staff blocked; /security stays open ──
  const setMfaReq = await req("PUT", "/rpc/security/policy", { slug: "acme", cookie: ownerCk, json: { mfaRequired: true } });
  check("owner enables mfaRequired (200)", setMfaReq.status === 200, `status ${setMfaReq.status}`);
  const blocked = await req("GET", "/rpc/projects", { slug: "acme", cookie: staffCk });
  check(
    "unenrolled staff blocked by mfaRequired (403 mfa_required)",
    blocked.status === 403 && blocked.body?.error === "mfa_required",
    `status ${blocked.status} ${JSON.stringify(blocked.body)}`,
  );
  const enrolledOk = await req("GET", "/rpc/projects", { slug: "acme", cookie: mfaCk });
  check("enrolled staff passes mfaRequired (200)", enrolledOk.status === 200, `status ${enrolledOk.status}`);
  const secStillOpen = await req("GET", "/rpc/security/mfa", { slug: "acme", cookie: staffCk });
  check("security surface stays reachable under mfaRequired", secStillOpen.status === 200, `status ${secStillOpen.status}`);
  // Contoso (no policy) is unaffected — cross-tenant isolation of the policy.
  const contosoUnaffected = await req("GET", "/rpc/projects", { slug: "contoso", cookie: contosoOwnerCk });
  check("contoso unaffected by acme's mfaRequired (200)", contosoUnaffected.status === 200, `status ${contosoUnaffected.status}`);
  // Reset so the flag doesn't leak into any later assertions.
  await req("PUT", "/rpc/security/policy", { slug: "acme", cookie: ownerCk, json: { mfaRequired: false } });

  // ── Y. Email integration: admin CRUD, secret never returned, role gate, isolation ──
  const intNone = await req("GET", "/rpc/integrations", { slug: "acme", cookie: ownerCk });
  check(
    "integrations: none configured returns null email",
    intNone.status === 200 && intNone.body?.email === null,
    `status ${intNone.status} ${JSON.stringify(intNone.body)}`,
  );

  // Create must include an API key.
  const intNoKey = await req("PUT", "/rpc/integrations/email", {
    slug: "acme",
    cookie: ownerCk,
    json: { provider: "resend", fromAddress: "no-reply@acme.test", enabled: true },
  });
  check("integrations: create without apiKey rejected (400)", intNoKey.status === 400, `status ${intNoKey.status}`);

  // Owner creates a Resend integration with a key.
  const intCreate = await req("PUT", "/rpc/integrations/email", {
    slug: "acme",
    cookie: ownerCk,
    json: {
      provider: "resend",
      apiKey: "re_super_secret_value",
      fromAddress: "no-reply@acme.test",
      fromName: "Acme",
      enabled: true,
    },
  });
  check(
    "owner creates email integration (200)",
    intCreate.status === 200 &&
      intCreate.body?.email?.provider === "resend" &&
      intCreate.body?.email?.enabled === true,
    `status ${intCreate.status} ${JSON.stringify(intCreate.body)}`,
  );
  check(
    "email integration API key is NEVER returned",
    intCreate.body?.email?.hasApiKey === true &&
      !JSON.stringify(intCreate.body).includes("re_super_secret_value"),
    JSON.stringify(intCreate.body?.email),
  );

  // GET returns it, secret-safe.
  const intGet = await req("GET", "/rpc/integrations", { slug: "acme", cookie: ownerCk });
  check(
    "integrations GET returns the email integration (hasApiKey, no secret)",
    intGet.status === 200 &&
      intGet.body?.email?.hasApiKey === true &&
      !JSON.stringify(intGet.body).includes("re_super_secret_value"),
    JSON.stringify(intGet.body?.email),
  );

  // Update WITHOUT a key keeps the stored one; switch provider + disable (so the
  // test-send below uses the platform console fallback, not a live provider call).
  const intUpd = await req("PUT", "/rpc/integrations/email", {
    slug: "acme",
    cookie: ownerCk,
    json: { provider: "sendgrid", fromAddress: "hello@acme.test", enabled: false },
  });
  check(
    "update without apiKey keeps stored key + switches provider",
    intUpd.status === 200 &&
      intUpd.body?.email?.provider === "sendgrid" &&
      intUpd.body?.email?.hasApiKey === true &&
      intUpd.body?.email?.enabled === false,
    JSON.stringify(intUpd.body?.email),
  );

  // Test send → console fallback (integration disabled) returns ok + provider.
  const intTest = await req("POST", "/rpc/integrations/email/test", { slug: "acme", cookie: ownerCk });
  check(
    "owner sends test email (200 + provider)",
    intTest.status === 200 && intTest.body?.ok === true && typeof intTest.body?.provider === "string",
    JSON.stringify(intTest.body),
  );

  // Role gate: staff cannot write/test/delete.
  const intStaffPut = await req("PUT", "/rpc/integrations/email", {
    slug: "acme",
    cookie: staffCk,
    json: { provider: "resend", apiKey: "x", fromAddress: "x@acme.test", enabled: true },
  });
  check("staff role blocked from integration write (403)", intStaffPut.status === 403, `status ${intStaffPut.status}`);
  const intStaffTest = await req("POST", "/rpc/integrations/email/test", { slug: "acme", cookie: staffCk });
  check("staff role blocked from integration test (403)", intStaffTest.status === 403, `status ${intStaffTest.status}`);
  const intStaffDel = await req("DELETE", "/rpc/integrations/email", { slug: "acme", cookie: staffCk });
  check("staff role blocked from integration delete (403)", intStaffDel.status === 403, `status ${intStaffDel.status}`);

  // Cross-tenant isolation (HTTP): contoso never sees acme's integration.
  const intContoso = await req("GET", "/rpc/integrations", { slug: "contoso", cookie: contosoOwnerCk });
  check(
    "contoso integration list excludes acme's (own null)",
    intContoso.status === 200 && intContoso.body?.email === null,
    `status ${intContoso.status} ${JSON.stringify(intContoso.body)}`,
  );
  // DB/RLS isolation: acme has its row; contoso cannot read it.
  const acmeInt = await withTenant(acmeId, (tx) => tx.select().from(tenantIntegration));
  const contosoInt = await withTenant(contosoId, (tx) => tx.select().from(tenantIntegration));
  check("RLS: acme has its own integration row", acmeInt.length === 1, `got ${acmeInt.length}`);
  check("RLS: contoso cannot read acme's integration row", contosoInt.length === 0, `got ${contosoInt.length}`);

  // Delete (owner) → gone (leaves no enabled integration for the lifecycle block).
  const intDel = await req("DELETE", "/rpc/integrations/email", { slug: "acme", cookie: ownerCk });
  check("owner deletes email integration (200)", intDel.status === 200, `status ${intDel.status}`);
  const intAfter = await req("GET", "/rpc/integrations", { slug: "acme", cookie: ownerCk });
  check("deleted integration gone (email null)", intAfter.body?.email === null, JSON.stringify(intAfter.body));

  // ── Z. Storage integration: BYO bucket via an injected mock adapter ──
  // A mock storage adapter (no live cloud) lets us exercise the upload path end
  // to end: an enabled integration routes branding uploads to the tenant base.
  const { __setStorageResolver } = await import("agora/server");
  const MOCK_BASE = "https://mock-bucket.s3.test/";
  const storagePuts: string[] = [];
  const storageDeletes: string[] = [];
  const mockStorage = {
    provider: "s3" as const,
    async put({ key }: { key: string; bytes: Uint8Array; contentType: string }) {
      storagePuts.push(key);
      return { url: `${MOCK_BASE}${key}`, key };
    },
    async delete(key: string) {
      storageDeletes.push(key);
    },
    keyFromUrl(url: string | null | undefined) {
      if (!url || !url.startsWith(MOCK_BASE)) return null;
      return url.slice(MOCK_BASE.length) || null;
    },
    publicUrl(key: string) { return `${MOCK_BASE}${key}`; },
    async signUpload(input: { key: string; contentType: string }) {
      return {
        provider: "s3" as const,
        url: `${MOCK_BASE}${input.key}`,
        method: "PUT" as const,
        fields: {},
        key: input.key,
      };
    },
    async signedDownloadUrl(key: string, _opts: any) { return `${MOCK_BASE}${key}`; },
  };
  __setStorageResolver(async () => mockStorage);

  // None configured yet → storage null.
  const stoNone = await req("GET", "/rpc/integrations", { slug: "acme", cookie: ownerCk });
  check(
    "storage: none configured returns null storage",
    stoNone.status === 200 && stoNone.body?.storage === null,
    `status ${stoNone.status} ${JSON.stringify(stoNone.body)}`,
  );

  // Create must include a secret access key.
  const stoNoSecret = await req("PUT", "/rpc/integrations/storage", {
    slug: "acme",
    cookie: ownerCk,
    json: { provider: "s3", bucket: "acme-assets", region: "us-east-1", accessKeyId: "AKIAEXAMPLE", enabled: true },
  });
  check("storage: create without secret rejected (400)", stoNoSecret.status === 400, `status ${stoNoSecret.status}`);

  // SSRF guard: an internal endpoint (cloud metadata) is rejected at write time.
  const stoSsrf = await req("PUT", "/rpc/integrations/storage", {
    slug: "acme",
    cookie: ownerCk,
    json: {
      provider: "s3",
      bucket: "acme-assets",
      region: "us-east-1",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "super-secret-s3-value",
      endpoint: "http://169.254.169.254",
      enabled: true,
    },
  });
  check("storage: SSRF endpoint rejected (400)", stoSsrf.status === 400, `status ${stoSsrf.status}`);
  const stoSsrfPrivate = await req("PUT", "/rpc/integrations/storage", {
    slug: "acme",
    cookie: ownerCk,
    json: {
      provider: "s3",
      bucket: "acme-assets",
      region: "us-east-1",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "super-secret-s3-value",
      publicBaseUrl: "https://10.0.0.5/assets",
      enabled: true,
    },
  });
  check("storage: SSRF private publicBaseUrl rejected (400)", stoSsrfPrivate.status === 400, `status ${stoSsrfPrivate.status}`);

  // SSRF guard on the AWS-native path: bucket/region are interpolated into the
  // request host, so a bucket that smuggles an authority (`@host`, `/`) must be
  // rejected by the contract before it can redirect the signed request.
  const stoSsrfBucket = await req("PUT", "/rpc/integrations/storage", {
    slug: "acme",
    cookie: ownerCk,
    json: {
      provider: "s3",
      bucket: "acme@169.254.169.254/",
      region: "us-east-1",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "super-secret-s3-value",
      enabled: true,
    },
  });
  check("storage: host-injection bucket rejected (400)", stoSsrfBucket.status === 400, `status ${stoSsrfBucket.status}`);
  const stoSsrfRegion = await req("PUT", "/rpc/integrations/storage", {
    slug: "acme",
    cookie: ownerCk,
    json: {
      provider: "s3",
      bucket: "acme-assets",
      region: "us-east-1.evil.com/",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "super-secret-s3-value",
      enabled: true,
    },
  });
  check("storage: host-injection region rejected (400)", stoSsrfRegion.status === 400, `status ${stoSsrfRegion.status}`);

  // Owner creates an S3 (AWS virtual-hosted) integration with a secret. No
  // custom endpoint/publicBaseUrl → no outbound DNS in the offline harness (the
  // SSRF cases above already exercise the public-https guard on those fields).
  const stoCreate = await req("PUT", "/rpc/integrations/storage", {
    slug: "acme",
    cookie: ownerCk,
    json: {
      provider: "s3",
      bucket: "acme-assets",
      region: "us-east-1",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "super-secret-s3-value",
      enabled: true,
    },
  });
  check(
    "owner creates storage integration (200)",
    stoCreate.status === 200 &&
      stoCreate.body?.storage?.provider === "s3" &&
      stoCreate.body?.storage?.bucket === "acme-assets" &&
      stoCreate.body?.storage?.enabled === true,
    `status ${stoCreate.status} ${JSON.stringify(stoCreate.body)}`,
  );
  check(
    "storage secret access key is NEVER returned",
    stoCreate.body?.storage?.hasSecret === true &&
      !JSON.stringify(stoCreate.body).includes("super-secret-s3-value"),
    JSON.stringify(stoCreate.body?.storage),
  );

  // GET returns it, secret-safe (accessKeyId is non-secret config and IS shown).
  const stoGet = await req("GET", "/rpc/integrations", { slug: "acme", cookie: ownerCk });
  check(
    "storage GET returns the integration (hasSecret, accessKeyId, no secret)",
    stoGet.status === 200 &&
      stoGet.body?.storage?.hasSecret === true &&
      stoGet.body?.storage?.accessKeyId === "AKIAEXAMPLE" &&
      !JSON.stringify(stoGet.body).includes("super-secret-s3-value"),
    JSON.stringify(stoGet.body?.storage),
  );

  // Test connection → writes + deletes a probe through the mock adapter.
  const stoTest = await req("POST", "/rpc/integrations/storage/test", { slug: "acme", cookie: ownerCk });
  check(
    "owner tests storage connection (200 + provider s3)",
    stoTest.status === 200 && stoTest.body?.ok === true && stoTest.body?.provider === "s3",
    JSON.stringify(stoTest.body),
  );
  check(
    "test connection wrote then deleted a probe object",
    storagePuts.some((k) => k.startsWith("integration-tests/")) &&
      storageDeletes.some((k) => k.startsWith("integration-tests/")),
    JSON.stringify({ puts: storagePuts, deletes: storageDeletes }),
  );

  // Branding upload now lands in the tenant bucket (URL on the tenant base).
  const stoUpload = await uploadAsset(ownerCk);
  check(
    "branding upload returns a URL on the tenant storage base",
    stoUpload.status === 200 &&
      typeof stoUpload.body?.url === "string" &&
      stoUpload.body!.url!.startsWith(MOCK_BASE) &&
      stoUpload.body!.url!.includes(`branding/${acmeId}/`),
    `status ${stoUpload.status} ${JSON.stringify(stoUpload.body)}`,
  );

  // Role gate: staff cannot write/test/delete the storage integration.
  const stoStaffPut = await req("PUT", "/rpc/integrations/storage", {
    slug: "acme",
    cookie: staffCk,
    // Valid body so the request reaches the role gate (zValidator runs first).
    json: { provider: "s3", bucket: "staff-denied", region: "us-east-1", accessKeyId: "x", secretAccessKey: "y", enabled: true },
  });
  check("staff role blocked from storage write (403)", stoStaffPut.status === 403, `status ${stoStaffPut.status}`);
  const stoStaffTest = await req("POST", "/rpc/integrations/storage/test", { slug: "acme", cookie: staffCk });
  check("staff role blocked from storage test (403)", stoStaffTest.status === 403, `status ${stoStaffTest.status}`);
  const stoStaffDel = await req("DELETE", "/rpc/integrations/storage", { slug: "acme", cookie: staffCk });
  check("staff role blocked from storage delete (403)", stoStaffDel.status === 403, `status ${stoStaffDel.status}`);

  // Cross-tenant isolation (HTTP): contoso never sees acme's storage integration.
  const stoContoso = await req("GET", "/rpc/integrations", { slug: "contoso", cookie: contosoOwnerCk });
  check(
    "contoso storage integration excludes acme's (own null)",
    stoContoso.status === 200 && stoContoso.body?.storage === null,
    `status ${stoContoso.status} ${JSON.stringify(stoContoso.body)}`,
  );
  // DB/RLS isolation: acme has its storage row; contoso cannot read it.
  const acmeSto = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantIntegration).where(eq(tenantIntegration.category, "storage")),
  );
  const contosoSto = await withTenant(contosoId, (tx) =>
    tx.select().from(tenantIntegration).where(eq(tenantIntegration.category, "storage")),
  );
  check("RLS: acme has its own storage integration row", acmeSto.length === 1, `got ${acmeSto.length}`);
  check("RLS: contoso cannot read acme's storage integration row", contosoSto.length === 0, `got ${contosoSto.length}`);

  // Delete (owner) → gone (leaves no enabled integration for the lifecycle block).
  const stoDel = await req("DELETE", "/rpc/integrations/storage", { slug: "acme", cookie: ownerCk });
  check("owner deletes storage integration (200)", stoDel.status === 200, `status ${stoDel.status}`);
  const stoAfter = await req("GET", "/rpc/integrations", { slug: "acme", cookie: ownerCk });
  check("deleted storage integration gone (storage null)", stoAfter.body?.storage === null, JSON.stringify(stoAfter.body));

  // ── Files: /rpc/files/* — sign/confirm/list/download-url/delete, role gate,
  //     cross-tenant isolation (the private-file leak proof). Reuses the mock
  //     storage adapter above (still injected at this point).
  const fSign = await req("POST", "/rpc/files/sign", {
    slug: "acme",
    cookie: staffCk,
    json: {
      originalName: "logo.png",
      contentType: "image/png",
      sizeBytes: 1024,
      visibility: "public",
    },
  });
  check(
    "staff signs a public file upload (201/200 + ticket + fileId)",
    fSign.status === 200 &&
      typeof fSign.body?.fileId === "string" &&
      typeof fSign.body?.ticket?.url === "string",
    `status ${fSign.status} ${JSON.stringify(fSign.body)}`,
  );
  const publicFileId = fSign.body?.fileId as string;
  const fConfirm = await req("POST", `/rpc/files/${publicFileId}/confirm`, {
    slug: "acme",
    cookie: staffCk,
    json: {},
  });
  check(
    "staff confirms the upload (200, status ready)",
    fConfirm.status === 200 && fConfirm.body?.status === "ready",
    `status ${fConfirm.status} ${JSON.stringify(fConfirm.body)}`,
  );

  // A private file, for the download-url + leak-proof checks below.
  const fSignPriv = await req("POST", "/rpc/files/sign", {
    slug: "acme",
    cookie: staffCk,
    json: {
      originalName: "contract.pdf",
      contentType: "application/pdf",
      sizeBytes: 2048,
      visibility: "private",
    },
  });
  const privateFileId = fSignPriv.body?.fileId as string;
  await req("POST", `/rpc/files/${privateFileId}/confirm`, {
    slug: "acme",
    cookie: staffCk,
    json: {},
  });

  // A featured file — the optional per-feature namespace nests under the
  // tenant's folder in the storage key (folder/feature/fileId).
  const fSignFeatured = await req("POST", "/rpc/files/sign", {
    slug: "acme",
    cookie: staffCk,
    json: {
      originalName: "avatar.png",
      contentType: "image/png",
      sizeBytes: 512,
      visibility: "public",
      feature: "avatars",
    },
  });
  check(
    "staff signs a featured file upload (200)",
    fSignFeatured.status === 200 && typeof fSignFeatured.body?.fileId === "string",
    `status ${fSignFeatured.status} ${JSON.stringify(fSignFeatured.body)}`,
  );
  const featuredFileId = fSignFeatured.body?.fileId as string;
  await req("POST", `/rpc/files/${featuredFileId}/confirm`, {
    slug: "acme",
    cookie: staffCk,
    json: {},
  });
  check(
    "sign rejects an invalid feature value (400)",
    (
      await req("POST", "/rpc/files/sign", {
        slug: "acme",
        cookie: staffCk,
        json: {
          originalName: "bad.png",
          contentType: "image/png",
          sizeBytes: 512,
          visibility: "public",
          feature: "-leading-dash-invalid",
        },
      })
    ).status === 400,
  );

  // List: public file carries a publicUrl, private file's is absent/null.
  const fList = await req("GET", "/rpc/files", { slug: "acme", cookie: staffCk });
  const listedPublic = (fList.body?.items ?? []).find((f: any) => f.id === publicFileId);
  const listedPrivate = (fList.body?.items ?? []).find((f: any) => f.id === privateFileId);
  const listedFeatured = (fList.body?.items ?? []).find((f: any) => f.id === featuredFileId);
  check(
    "list: featured file's storageKey is <tenant folder>/avatars/<fileId>, feature returned",
    listedFeatured?.feature === "avatars" &&
      listedFeatured?.storageKey === `${acmeId}/avatars/${featuredFileId}`,
    JSON.stringify(listedFeatured),
  );
  check(
    "list: non-featured file's storageKey is <tenant folder>/<fileId>, no feature segment",
    listedPublic?.feature === null && listedPublic?.storageKey === `${acmeId}/${publicFileId}`,
    JSON.stringify(listedPublic),
  );

  // Tenant folder: acme's key is rooted at acmeId; a contoso-signed file is
  // rooted at contosoId — distinct per-tenant folders, not just per-feature.
  const fSignContoso = await req("POST", "/rpc/files/sign", {
    slug: "contoso",
    cookie: contosoOwnerCk,
    json: {
      originalName: "contoso-logo.png",
      contentType: "image/png",
      sizeBytes: 256,
      visibility: "public",
    },
  });
  const contosoFileId = fSignContoso.body?.fileId as string;
  await req("POST", `/rpc/files/${contosoFileId}/confirm`, {
    slug: "contoso",
    cookie: contosoOwnerCk,
    json: {},
  });
  const fListContosoFolder = await req("GET", "/rpc/files", {
    slug: "contoso",
    cookie: contosoOwnerCk,
  });
  const listedContoso = (fListContosoFolder.body?.items ?? []).find(
    (f: any) => f.id === contosoFileId,
  );
  check(
    "tenant folder: contoso's file is rooted at contosoId, not acmeId",
    listedContoso?.storageKey === `${contosoId}/${contosoFileId}` &&
      !listedContoso?.storageKey?.startsWith(`${acmeId}/`),
    JSON.stringify(listedContoso),
  );
  check(
    "list: public file has a publicUrl",
    fList.status === 200 && typeof listedPublic?.publicUrl === "string",
    JSON.stringify(listedPublic),
  );
  check(
    "list: private file has no publicUrl",
    !listedPrivate?.publicUrl,
    JSON.stringify(listedPrivate),
  );

  // Role gate: staff may create/read but not delete.
  const fDelAsStaff = await req("DELETE", `/rpc/files/${publicFileId}`, {
    slug: "acme",
    cookie: staffCk,
  });
  check("staff role blocked from file delete (403)", fDelAsStaff.status === 403, `status ${fDelAsStaff.status}`);
  const fDownload = await req("GET", `/rpc/files/${privateFileId}/download-url`, {
    slug: "acme",
    cookie: staffCk,
  });
  check(
    "staff reads a private download-url (200)",
    fDownload.status === 200 && typeof fDownload.body?.url === "string",
    `status ${fDownload.status} ${JSON.stringify(fDownload.body)}`,
  );

  // Cross-tenant isolation (HTTP): contoso cannot list, download, or delete
  // acme's files — the private-file leak proof.
  const fListContoso = await req("GET", "/rpc/files", { slug: "contoso", cookie: contosoOwnerCk });
  check(
    "contoso file list excludes acme's files",
    fListContoso.status === 200 &&
      !(fListContoso.body?.items ?? []).some((f: any) => f.id === publicFileId || f.id === privateFileId),
    JSON.stringify(fListContoso.body?.items),
  );
  const fDownloadContoso = await req("GET", `/rpc/files/${privateFileId}/download-url`, {
    slug: "contoso",
    cookie: contosoOwnerCk,
  });
  check(
    "contoso download-url on acme's private file → 404",
    fDownloadContoso.status === 404,
    `status ${fDownloadContoso.status}`,
  );
  const fDeleteContoso = await req("DELETE", `/rpc/files/${publicFileId}`, {
    slug: "contoso",
    cookie: contosoOwnerCk,
  });
  check(
    "contoso delete on acme's public file → 404",
    fDeleteContoso.status === 404,
    `status ${fDeleteContoso.status}`,
  );

  // DB/RLS isolation: acme's rows are invisible to a contoso-scoped read.
  const acmeFiles = await withTenant(acmeId, (tx) => tx.select().from(storedFile));
  const contosoFilesRls = await withTenant(contosoId, (tx) => tx.select().from(storedFile));
  check("RLS: acme has its own stored_file rows", acmeFiles.length === 3, `got ${acmeFiles.length}`);
  check(
    "RLS: contoso-scoped read sees only its own file, never acme's",
    contosoFilesRls.length === 1 && contosoFilesRls.every((f) => f.tenantId === contosoId),
    `got ${contosoFilesRls.length}`,
  );

  // Owner/admin can delete.
  const fDelAsOwner = await req("DELETE", `/rpc/files/${publicFileId}`, {
    slug: "acme",
    cookie: ownerCk,
  });
  check("owner deletes file (200)", fDelAsOwner.status === 200, `status ${fDelAsOwner.status}`);
  const fListAfterDelete = await req("GET", "/rpc/files", { slug: "acme", cookie: ownerCk });
  check(
    "deleted file no longer listed (soft-delete)",
    !(fListAfterDelete.body?.items ?? []).some((f: any) => f.id === publicFileId),
    JSON.stringify(fListAfterDelete.body?.items),
  );

  // Audit: upload + delete both recorded.
  const fAudit = await req("GET", "/rpc/audit", { slug: "acme", cookie: ownerCk });
  const fAuditActions: string[] = (fAudit.body?.items ?? []).map((e: any) => e.action);
  check(
    "audit includes file.uploaded + file.deleted",
    fAuditActions.includes("file.uploaded") && fAuditActions.includes("file.deleted"),
    fAuditActions.join(","),
  );

  // Reset the resolver so the lifecycle purge below uses the real platform store.
  __setStorageResolver(null);

  // ── T1. Staff membership management: role change / remove / transfer, with
  //     escalation + last-owner guards and cross-tenant isolation. Uses
  //     throwaway members so owner@/staff@ stay intact for the blocks below.
  const extraUser = await ensureStaff("extra@acme.test", "Acme Extra");
  await addMember(acmeId, extraUser, "staff");
  const extra2User = await ensureStaff("extra2@acme.test", "Acme Extra Two");
  await addMember(acmeId, extra2User, "staff");

  const memList0 = await req("GET", "/rpc/members", { slug: "acme", cookie: ownerCk });
  const findMem = (email: string) =>
    (memList0.body?.items ?? []).find((m: any) => m.email === email);
  const extraId = findMem("extra@acme.test")?.id as string;
  const extra2Id = findMem("extra2@acme.test")?.id as string;
  const ownerMemId = findMem("owner@acme.test")?.id as string;

  // Happy path: owner promotes a staff member to admin.
  const roleUp = await req("PATCH", `/rpc/members/${extraId}/role`, {
    slug: "acme",
    cookie: ownerCk,
    json: { role: "admin" },
  });
  check(
    "owner changes a staff member to admin (200)",
    roleUp.status === 200 && roleUp.body?.member?.role === "admin",
    `status ${roleUp.status} ${JSON.stringify(roleUp.body)}`,
  );

  // Role gate: a staff-role user cannot change roles.
  const roleStaff = await req("PATCH", `/rpc/members/${extraId}/role`, {
    slug: "acme",
    cookie: staffCk,
    json: { role: "staff" },
  });
  check("staff role blocked from role change (403)", roleStaff.status === 403, `status ${roleStaff.status}`);

  // Escalation: an admin can neither mint an owner nor re-role someone above them.
  const adminCk = await staffCookie("extra@acme.test");

  // ── T1a. Notification feed: the role-change trigger above just created a
  //     "role_changed" row for extra@acme.test (recipientUserId-scoped, not
  //     just tenant-scoped) — happy path, per-user isolation (staff@acme.test
  //     is a DIFFERENT member of the SAME tenant and must not see it), and
  //     cross-tenant isolation (contoso's owner must not see it either).
  const feedRecipient = await req("GET", "/rpc/notification-feed", { slug: "acme", cookie: adminCk });
  const feedItems: any[] = feedRecipient.body?.items ?? [];
  const roleChangedNotif = feedItems.find((n) => n.type === "role_changed");
  check(
    "role-change recipient sees the notification, unread",
    feedRecipient.status === 200 &&
      Boolean(roleChangedNotif) &&
      roleChangedNotif?.readAt === null &&
      feedRecipient.body?.unreadCount >= 1,
    JSON.stringify(feedRecipient.body),
  );
  check(
    "role-change notification carries the acting admin's identity as actorName (not null)",
    typeof roleChangedNotif?.actorName === "string" && roleChangedNotif.actorName.length > 0,
    JSON.stringify(roleChangedNotif),
  );

  const feedOtherMember = await req("GET", "/rpc/notification-feed", { slug: "acme", cookie: staffCk });
  check(
    "a DIFFERENT member of the same tenant does NOT see it (per-user isolation)",
    feedOtherMember.status === 200 &&
      !(feedOtherMember.body?.items ?? []).some((n: any) => n.id === roleChangedNotif?.id),
    JSON.stringify(feedOtherMember.body),
  );

  const feedCrossTenant = await req("GET", "/rpc/notification-feed", { slug: "contoso", cookie: contosoOwnerCk });
  check(
    "a member of a DIFFERENT tenant does NOT see it (cross-tenant isolation)",
    feedCrossTenant.status === 200 &&
      !(feedCrossTenant.body?.items ?? []).some((n: any) => n.id === roleChangedNotif?.id),
    JSON.stringify(feedCrossTenant.body),
  );

  // Ownership: another member of the SAME tenant cannot mark it read (404 —
  // never leak whether the id exists via a 403/404 distinction).
  const markReadWrongUser = await req(
    "POST",
    `/rpc/notification-feed/${roleChangedNotif?.id}/read`,
    { slug: "acme", cookie: staffCk },
  );
  check("wrong member marking it read → 404", markReadWrongUser.status === 404, `status ${markReadWrongUser.status}`);

  // Happy path: the recipient marks their own notification read (idempotent).
  const markRead = await req("POST", `/rpc/notification-feed/${roleChangedNotif?.id}/read`, {
    slug: "acme",
    cookie: adminCk,
  });
  const markReadAgain = await req("POST", `/rpc/notification-feed/${roleChangedNotif?.id}/read`, {
    slug: "acme",
    cookie: adminCk,
  });
  check(
    "recipient marks their own notification read (200, idempotent)",
    markRead.status === 200 && markReadAgain.status === 200,
    `status ${markRead.status} / ${markReadAgain.status}`,
  );

  const feedAfterRead = await req("GET", "/rpc/notification-feed", { slug: "acme", cookie: adminCk });
  const readItem = (feedAfterRead.body?.items ?? []).find((n: any) => n.id === roleChangedNotif?.id);
  check(
    "notification shows read after marking it read",
    Boolean(readItem?.readAt),
    JSON.stringify(readItem),
  );

  // mark-all-read: unreadCount drops to 0 for this member.
  const markAllRead = await req("POST", "/rpc/notification-feed/mark-all-read", {
    slug: "acme",
    cookie: adminCk,
  });
  const feedAfterMarkAll = await req("GET", "/rpc/notification-feed", { slug: "acme", cookie: adminCk });
  check(
    "mark-all-read zeroes this member's unread count",
    markAllRead.status === 200 && feedAfterMarkAll.body?.unreadCount === 0,
    `status ${markAllRead.status} unreadCount ${feedAfterMarkAll.body?.unreadCount}`,
  );

  const escalate = await req("PATCH", `/rpc/members/${extra2Id}/role`, {
    slug: "acme",
    cookie: adminCk,
    json: { role: "owner" },
  });
  check("admin cannot promote to owner — escalation blocked (403)", escalate.status === 403, `status ${escalate.status}`);
  const manageOwner = await req("PATCH", `/rpc/members/${ownerMemId}/role`, {
    slug: "acme",
    cookie: adminCk,
    json: { role: "admin" },
  });
  check("admin cannot re-role an owner — outranked (403)", manageOwner.status === 403, `status ${manageOwner.status}`);

  // Last-owner protection: the final owner can't be demoted or removed.
  const demoteOwner = await req("PATCH", `/rpc/members/${ownerMemId}/role`, {
    slug: "acme",
    cookie: ownerCk,
    json: { role: "admin" },
  });
  check("last owner cannot be demoted (409)", demoteOwner.status === 409, `status ${demoteOwner.status}`);
  const removeOwner = await req("DELETE", `/rpc/members/${ownerMemId}`, { slug: "acme", cookie: ownerCk });
  check("last owner cannot be removed (409)", removeOwner.status === 409, `status ${removeOwner.status}`);

  // Cross-tenant: a member id from contoso is Not Found under acme.
  const contosoMems = await req("GET", "/rpc/members", { slug: "contoso", cookie: contosoOwnerCk });
  const contosoMemId = (contosoMems.body?.items ?? [])[0]?.id as string;
  const crossRole = await req("PATCH", `/rpc/members/${contosoMemId}/role`, {
    slug: "acme",
    cookie: ownerCk,
    json: { role: "staff" },
  });
  check("cross-tenant member id → 404", crossRole.status === 404, `status ${crossRole.status}`);

  // Transfer role gate: a staff-role user cannot transfer ownership.
  const transferStaff = await req("POST", `/rpc/members/${extraId}/transfer-ownership`, {
    slug: "acme",
    cookie: staffCk,
  });
  check("non-owner blocked from transfer (403)", transferStaff.status === 403, `status ${transferStaff.status}`);

  // Remove: a signed-in member loses access after removal.
  const extra2Ck = await staffCookie("extra2@acme.test");
  const preRemove = await req("GET", "/rpc/me", { slug: "acme", cookie: extra2Ck });
  check("member can access before removal (200)", preRemove.status === 200, `status ${preRemove.status}`);
  const removeOk = await req("DELETE", `/rpc/members/${extra2Id}`, { slug: "acme", cookie: ownerCk });
  check("owner removes a staff member (200)", removeOk.status === 200, `status ${removeOk.status}`);
  const postRemove = await req("GET", "/rpc/me", { slug: "acme", cookie: extra2Ck });
  check("removed member loses access (not 200)", postRemove.status !== 200, `status ${postRemove.status}`);
  const memListAfter = await req("GET", "/rpc/members", { slug: "acme", cookie: ownerCk });
  check(
    "removed member no longer listed",
    !(memListAfter.body?.items ?? []).some((m: any) => m.email === "extra2@acme.test"),
    JSON.stringify(memListAfter.body?.items),
  );

  // Transfer ownership: roles swap, then transfer back so owner@ stays owner
  // for the lifecycle blocks below.
  const transfer = await req("POST", `/rpc/members/${extraId}/transfer-ownership`, {
    slug: "acme",
    cookie: ownerCk,
  });
  check("owner transfers ownership (200)", transfer.status === 200, `status ${transfer.status}`);
  const swapList = await req("GET", "/rpc/members", { slug: "acme", cookie: adminCk });
  const extraAfter = (swapList.body?.items ?? []).find((m: any) => m.email === "extra@acme.test");
  const ownerAfter = (swapList.body?.items ?? []).find((m: any) => m.email === "owner@acme.test");
  check(
    "ownership swapped (target=owner, previous owner=admin)",
    extraAfter?.role === "owner" && ownerAfter?.role === "admin",
    JSON.stringify({ extraAfter, ownerAfter }),
  );
  const transferBack = await req("POST", `/rpc/members/${ownerMemId}/transfer-ownership`, {
    slug: "acme",
    cookie: adminCk,
  });
  check("ownership transferred back to original owner (200)", transferBack.status === 200, `status ${transferBack.status}`);
  const restored = await req("GET", "/rpc/me", { slug: "acme", cookie: ownerCk });
  check("original owner is owner again", restored.body?.role === "owner", JSON.stringify(restored.body));

  // ── T1b. Permission-based RBAC: the permission set, the gates it drives,
  //     the API-key actor, and the owner-only boundaries. ──

  // /me exposes the computed set the dashboard gates on.
  const permOwner = await req("GET", "/rpc/me", { slug: "acme", cookie: ownerCk });
  check(
    "/me returns a permission set for owner",
    permOwner.status === 200 &&
      (permOwner.body?.permissions?.tenant ?? []).includes("delete") &&
      (permOwner.body?.permissions?.billing ?? []).includes("manage"),
    JSON.stringify(permOwner.body?.permissions?.tenant),
  );
  const permStaff = await req("GET", "/rpc/me", { slug: "acme", cookie: staffCk });
  check(
    "/me permission set for staff is project:create only",
    permStaff.status === 200 &&
      (permStaff.body?.permissions?.project ?? []).includes("create") &&
      !(permStaff.body?.permissions?.project ?? []).includes("delete") &&
      (permStaff.body?.permissions?.customer ?? []).length === 0,
    JSON.stringify(permStaff.body?.permissions),
  );

  // (a) permitted action succeeds — admin holds customer:read.
  const permAllowed = await req("GET", "/rpc/customers", { slug: "acme", cookie: adminCk });
  check(
    "permitted action succeeds (admin customer:read 200)",
    permAllowed.status === 200,
    `status ${permAllowed.status}`,
  );

  // (b) the same action is denied for a role without the permission.
  const permDenied = await req("GET", "/rpc/customers", { slug: "acme", cookie: staffCk });
  check(
    "same action denied without the permission (staff customer:read 403)",
    permDenied.status === 403,
    `status ${permDenied.status}`,
  );

  // (c) an API-key actor is gated by the identical code path as a session.
  const permKeyCreate = await req("POST", "/rpc/api-keys", {
    slug: "acme",
    cookie: ownerCk,
    json: { name: "E2E Perm Key", role: "staff" },
  });
  const permKeySecret = permKeyCreate.body?.apiKey?.secret as string | undefined;
  const permKeyAllowed = await req("POST", "/rpc/projects", {
    slug: "acme",
    bearer: permKeySecret,
    json: { name: "Perm Key Project" },
  });
  check(
    "api-key actor allowed where its role permits (staff project:create 201)",
    permKeyAllowed.status === 201,
    `status ${permKeyAllowed.status}`,
  );
  const permKeyDenied = await req("GET", "/rpc/customers", {
    slug: "acme",
    bearer: permKeySecret,
  });
  check(
    "api-key actor denied where its role does not permit (staff customer:read 403)",
    permKeyDenied.status === 403,
    `status ${permKeyDenied.status}`,
  );

  // (d) cross-tenant still refused before permissions are even consulted.
  const permCrossTenant = await req("GET", "/rpc/customers", {
    slug: "contoso",
    cookie: adminCk,
  });
  check(
    "cross-tenant attempt refused regardless of permission (403)",
    permCrossTenant.status === 403,
    `status ${permCrossTenant.status}`,
  );

  // The other owner-only boundary: the tenant resource. An admin holds no
  // tenant:* permission, so lifecycle and export must refuse them. Suspend and
  // delete are deliberately NOT probed here — a 403 assertion that accidentally
  // succeeded would take the tenant down mid-suite.
  const lifecycleAdmin = await req("GET", "/rpc/tenant/lifecycle", {
    slug: "acme",
    cookie: adminCk,
  });
  check(
    "admin blocked from tenant lifecycle — owner-only (403)",
    lifecycleAdmin.status === 403,
    `status ${lifecycleAdmin.status}`,
  );
  const exportAdmin = await req("GET", "/rpc/tenant/export", {
    slug: "acme",
    cookie: adminCk,
  });
  check(
    "admin blocked from tenant export — owner-only (403)",
    exportAdmin.status === 403,
    `status ${exportAdmin.status}`,
  );

  // (e) the owner-only boundary the plan audit found untested: billing:manage.
  // An admin may read billing but must not reach checkout or the portal.
  const billingReadAdmin = await req("GET", "/rpc/billing", { slug: "acme", cookie: adminCk });
  check(
    "admin may read billing (billing:read)",
    billingReadAdmin.status === 200,
    `status ${billingReadAdmin.status}`,
  );
  const checkoutAdmin = await req("POST", "/rpc/billing/checkout", {
    slug: "acme",
    cookie: adminCk,
    json: { plan: "pro" },
  });
  check(
    "admin blocked from billing checkout — owner-only (403)",
    checkoutAdmin.status === 403,
    `status ${checkoutAdmin.status}`,
  );
  const portalAdmin = await req("POST", "/rpc/billing/portal", { slug: "acme", cookie: adminCk });
  check(
    "admin blocked from billing portal — owner-only (403)",
    portalAdmin.status === 403,
    `status ${portalAdmin.status}`,
  );

  // ── T1c. Tenant-defined custom roles: CRUD, the three escalation guards,
  //     live permission resolution, and cross-tenant isolation. ──

  const rolesList = await req("GET", "/rpc/roles", { slug: "acme", cookie: ownerCk });
  const systemKeys = (rolesList.body?.roles ?? [])
    .filter((r: any) => r.isSystem)
    .map((r: any) => r.key)
    .sort();
  check(
    "owner lists roles incl. the three immutable built-ins",
    rolesList.status === 200 &&
      JSON.stringify(systemKeys) === JSON.stringify(["admin", "owner", "staff"]),
    JSON.stringify(systemKeys),
  );
  const rolesStaff = await req("GET", "/rpc/roles", { slug: "acme", cookie: staffCk });
  check(
    "staff blocked from listing roles (403)",
    rolesStaff.status === 403,
    `status ${rolesStaff.status}`,
  );

  // Create a custom role granting exactly one thing staff normally lack.
  const roleCreate = await req("POST", "/rpc/roles", {
    slug: "acme",
    cookie: ownerCk,
    json: {
      key: "customer-desk",
      name: "Customer Desk",
      permissions: { customer: ["read"] },
    },
  });
  check(
    "owner creates a custom role (201)",
    roleCreate.status === 201 && roleCreate.body?.role?.key === "customer-desk",
    `status ${roleCreate.status}`,
  );

  // Guard 1: built-in roles are code-defined and cannot be edited or deleted.
  const editSystem = await req("PATCH", "/rpc/roles/admin", {
    slug: "acme",
    cookie: ownerCk,
    json: { name: "Nope" },
  });
  check(
    "built-in role cannot be edited (400)",
    editSystem.status === 400,
    `status ${editSystem.status}`,
  );
  const delSystem = await req("DELETE", "/rpc/roles/owner", { slug: "acme", cookie: ownerCk });
  check(
    "built-in role cannot be deleted (400)",
    delSystem.status === 400,
    `status ${delSystem.status}`,
  );

  // Guard 2: you cannot grant a permission you do not hold. An admin holds no
  // tenant:delete, so it must not be able to mint a role carrying it and
  // escalate past the owner-only boundary.
  const escalateRole = await req("POST", "/rpc/roles", {
    slug: "acme",
    cookie: adminCk,
    json: { key: "backdoor", name: "Backdoor", permissions: { tenant: ["delete"] } },
  });
  check(
    "admin cannot mint a role granting owner-only tenant:delete (403)",
    escalateRole.status === 403,
    `status ${escalateRole.status}`,
  );
  const unknownPerm = await req("POST", "/rpc/roles", {
    slug: "acme",
    cookie: ownerCk,
    json: { key: "bogus", name: "Bogus", permissions: { nosuch: ["read"] } },
  });
  check(
    "unknown resource rejected rather than silently dropped (400)",
    unknownPerm.status === 400,
    `status ${unknownPerm.status}`,
  );

  // Resolution: assigning the role must actually change what its holder can do.
  await adminDb
    .update(schema.member)
    .set({ role: "customer-desk" })
    .where(
      and(
        eq(schema.member.organizationId, acmeId),
        eq(schema.member.userId, acmeStaff),
      ),
    );
  const deskMe = await req("GET", "/rpc/me", { slug: "acme", cookie: staffCk });
  check(
    "custom role resolves onto /me permissions",
    deskMe.status === 200 &&
      (deskMe.body?.permissions?.customer ?? []).includes("read") &&
      (deskMe.body?.permissions?.project ?? []).length === 0,
    JSON.stringify(deskMe.body?.permissions?.customer),
  );
  const deskAllowed = await req("GET", "/rpc/customers", { slug: "acme", cookie: staffCk });
  check(
    "custom role grants the action it was given (customer:read 200)",
    deskAllowed.status === 200,
    `status ${deskAllowed.status}`,
  );
  const deskDenied = await req("POST", "/rpc/projects", {
    slug: "acme",
    cookie: staffCk,
    json: { name: "Should Fail" },
  });
  check(
    "custom role denies everything it was not given (project:create 403)",
    deskDenied.status === 403,
    `status ${deskDenied.status}`,
  );

  // Guard 3: a role still assigned cannot be deleted — its holders would
  // silently lose every permission on their next request.
  const delAssigned = await req("DELETE", "/rpc/roles/customer-desk", {
    slug: "acme",
    cookie: ownerCk,
  });
  check(
    "assigned role cannot be deleted (409)",
    delAssigned.status === 409,
    `status ${delAssigned.status}`,
  );

  // Cross-tenant: acme's custom role is invisible and unusable in contoso.
  const contosoRoles = await req("GET", "/rpc/roles", {
    slug: "contoso",
    cookie: contosoOwnerCk,
  });
  check(
    "acme's custom role is invisible to contoso (isolation)",
    contosoRoles.status === 200 &&
      !(contosoRoles.body?.roles ?? []).some((r: any) => r.key === "customer-desk"),
    JSON.stringify((contosoRoles.body?.roles ?? []).map((r: any) => r.key)),
  );
  const contosoDelete = await req("DELETE", "/rpc/roles/customer-desk", {
    slug: "contoso",
    cookie: contosoOwnerCk,
  });
  check(
    "contoso cannot delete acme's role (404)",
    contosoDelete.status === 404,
    `status ${contosoDelete.status}`,
  );

  // Unassign, then the delete is allowed.
  await adminDb
    .update(schema.member)
    .set({ role: "staff" })
    .where(
      and(
        eq(schema.member.organizationId, acmeId),
        eq(schema.member.userId, acmeStaff),
      ),
    );
  const delFree = await req("DELETE", "/rpc/roles/customer-desk", {
    slug: "acme",
    cookie: ownerCk,
  });
  check("unassigned role deletes (200)", delFree.status === 200, `status ${delFree.status}`);
  const afterDelete = await req("GET", "/rpc/roles", { slug: "acme", cookie: ownerCk });
  check(
    "deleted role is gone from the list",
    !(afterDelete.body?.roles ?? []).some((r: any) => r.key === "customer-desk"),
  );

  // ── T2. Customer admin management: create / suspend / reactivate / edit,
  //     with role gate, duplicate guard, and cross-tenant isolation. ──
  const NCPW = "CustPass123!";
  const custCreate = await req("POST", "/rpc/customers", {
    slug: "acme",
    cookie: ownerCk,
    json: { email: "managed@acme.test", name: "Managed Cust", password: NCPW },
  });
  check(
    "admin creates a customer (201, active)",
    custCreate.status === 201 && custCreate.body?.customer?.status === "active",
    `status ${custCreate.status} ${JSON.stringify(custCreate.body)}`,
  );
  const managedId = custCreate.body?.customer?.id as string;

  const custStaff = await req("POST", "/rpc/customers", {
    slug: "acme",
    cookie: staffCk,
    json: { email: "nope@acme.test", name: "Nope", password: NCPW },
  });
  check("staff role blocked from customer create (403)", custStaff.status === 403, `status ${custStaff.status}`);

  const custDup = await req("POST", "/rpc/customers", {
    slug: "acme",
    cookie: ownerCk,
    json: { email: "managed@acme.test", name: "Dup", password: NCPW },
  });
  check("duplicate customer email (409)", custDup.status === 409, `status ${custDup.status}`);

  const custLogin = await req("POST", "/portal/auth/sign-in", {
    slug: "acme",
    json: { email: "managed@acme.test", password: NCPW },
  });
  check("created customer can sign in (200)", custLogin.status === 200, `status ${custLogin.status}`);
  const managedCk = jar(custLogin.setCookie);

  const susp = await req("POST", `/rpc/customers/${managedId}/suspend`, { slug: "acme", cookie: ownerCk });
  check(
    "admin suspends customer (200, suspended)",
    susp.status === 200 && susp.body?.customer?.status === "suspended",
    `status ${susp.status} ${JSON.stringify(susp.body)}`,
  );
  const loginSusp = await req("POST", "/portal/auth/sign-in", {
    slug: "acme",
    json: { email: "managed@acme.test", password: NCPW },
  });
  check("suspended customer sign-in blocked (403)", loginSusp.status === 403, `status ${loginSusp.status}`);
  const meSusp = await req("GET", "/portal/auth/me", { slug: "acme", cookie: managedCk });
  check("suspended customer live session revoked (not 200)", meSusp.status !== 200, `status ${meSusp.status}`);

  const react = await req("POST", `/rpc/customers/${managedId}/reactivate`, { slug: "acme", cookie: ownerCk });
  check(
    "admin reactivates customer (200, active)",
    react.status === 200 && react.body?.customer?.status === "active",
    `status ${react.status} ${JSON.stringify(react.body)}`,
  );
  const loginReact = await req("POST", "/portal/auth/sign-in", {
    slug: "acme",
    json: { email: "managed@acme.test", password: NCPW },
  });
  check("reactivated customer can sign in (200)", loginReact.status === 200, `status ${loginReact.status}`);

  const custEdit = await req("PATCH", `/rpc/customers/${managedId}`, {
    slug: "acme",
    cookie: ownerCk,
    json: { name: "Renamed Cust" },
  });
  check(
    "admin edits a customer (200, renamed)",
    custEdit.status === 200 && custEdit.body?.customer?.name === "Renamed Cust",
    `status ${custEdit.status} ${JSON.stringify(custEdit.body)}`,
  );

  const suspStaff = await req("POST", `/rpc/customers/${managedId}/suspend`, { slug: "acme", cookie: staffCk });
  check("staff role blocked from customer suspend (403)", suspStaff.status === 403, `status ${suspStaff.status}`);

  // Cross-tenant: contoso cannot see or mutate acme's customer (RLS invisible).
  const custCross = await req("POST", `/rpc/customers/${managedId}/suspend`, {
    slug: "contoso",
    cookie: contosoOwnerCk,
  });
  check("cross-tenant customer suspend → 404 (RLS invisible)", custCross.status === 404, `status ${custCross.status}`);
  const contosoCustList = await req("GET", "/rpc/customers", { slug: "contoso", cookie: contosoOwnerCk });
  check(
    "contoso customer list excludes acme's managed customer",
    !(contosoCustList.body?.items ?? []).some((m: any) => m.email === "managed@acme.test"),
    JSON.stringify(contosoCustList.body?.items),
  );

  // ── Chrono growth loop: demand read gate + cross-tenant isolation ──
  //
  // Placed BEFORE section U on purpose: U suspends acme, and a suspended
  // tenant stops resolving at all (resolveOrgFromRequest returns null for a
  // terminal status), so anything sited after it cannot read acme.
  //
  // ChronoBusinessLeads is deliberately NOT under RLS (a lead is captured
  // before the business it names has any tenant), so `rls:proof` cannot and
  // does not cover GET /rpc/growth/demand. The ONLY isolation on that route is
  // the server-derived normalized-name predicate — which makes the
  // cross-tenant case below this feature's real isolation proof, exactly as
  // the foundation documents for readPublishedLandingPage.
  {
    // A lead's requesterCustomerId is a real FK into the global customer pool,
    // so the requester has to exist before the leads do.
    const [growthCustomer] = await adminDb
      .insert(schema.customer)
      .values({
        name: "Growth Lead Requester",
        email: `growth-${createId()}@example.com`,
        // Never signs in — the row only has to exist to satisfy the lead's FK.
        passwordHash: "e2e-not-a-real-hash",
      })
      .returning({ id: schema.customer.id, email: schema.customer.email });

    // One lead naming acme ("Acme Corp" → "acme corp"), one naming a business
    // neither tenant owns.
    await adminDb.insert(chronoBusinessLead).values([
      // Deliberately messy casing/whitespace: the normalizer is what makes
      // this match, and a regression there is exactly what this catches.
      {
        businessName: "  Acme   CORP  ",
        businessNameNormalized: "acme corp",
        requesterCustomerId: growthCustomer!.id,
      },
      // A lead for a business nobody in this harness owns — it must never be
      // counted by either tenant.
      {
        businessName: "Some Other Cafe",
        businessNameNormalized: "some other cafe",
        requesterCustomerId: growthCustomer!.id,
      },
    ]);

    // Role gate. growth:read is admin+ ONLY, so acme's staff member — who
    // holds a real staff role, not a stripped custom one — must be refused.
    // This assertion FAILS if growth:read is ever added to CHRONO_STAFF_GRANTS,
    // which is the whole point: it tests the boundary, not deny-by-default.
    const demandStaff = await req("GET", "/rpc/growth/demand", {
      slug: "acme",
      cookie: staffCk,
    });
    check(
      "growth: staff denied GET /rpc/growth/demand (403) — admin+ only",
      demandStaff.status === 403,
      `status ${demandStaff.status}`,
    );

    const demandOwner = await req("GET", "/rpc/growth/demand", {
      slug: "acme",
      cookie: ownerCk,
    });
    check(
      "growth: acme owner sees its own demand count (200, exactly 1)",
      demandOwner.status === 200 && demandOwner.body?.count === 1,
      JSON.stringify(demandOwner.body),
    );

    // Cross-tenant isolation — the real proof for this feature.
    const demandContoso = await req("GET", "/rpc/growth/demand", {
      slug: "contoso",
      cookie: contosoOwnerCk,
    });
    check(
      "growth: contoso NEVER sees acme's lead (200, count 0)",
      demandContoso.status === 200 && demandContoso.body?.count === 0,
      JSON.stringify(demandContoso.body),
    );

    // The response is a bare count — it must never carry a lead field or the
    // requester's identity, or this route becomes a back-door lead read.
    check(
      "growth: demand response exposes ONLY a count (no lead fields, no requester)",
      demandOwner.status === 200 &&
        JSON.stringify(Object.keys(demandOwner.body ?? {}).sort()) === JSON.stringify(["count"]),
      JSON.stringify(Object.keys(demandOwner.body ?? {})),
    );

    // ── GET /rpc/growth/leads (Phase 5, lead-detail console) — same gate,
    //    same isolation predicate, plus its own no-PII shape assertion. ──
    const leadsStaff = await req("GET", "/rpc/growth/leads", {
      slug: "acme",
      cookie: staffCk,
    });
    check(
      "growth: staff denied GET /rpc/growth/leads (403) — admin+ only",
      leadsStaff.status === 403,
      `status ${leadsStaff.status}`,
    );

    const leadsOwner = await req("GET", "/rpc/growth/leads", {
      slug: "acme",
      cookie: ownerCk,
    });
    check(
      "growth: acme owner sees exactly its own 1 lead row",
      leadsOwner.status === 200 &&
        leadsOwner.body?.items?.length === 1 &&
        leadsOwner.body?.meta?.totalItems === 1,
      JSON.stringify(leadsOwner.body),
    );
    check(
      "growth: leads row carries the typed fields, normalized-name matched",
      leadsOwner.body?.items?.[0]?.businessName === "  Acme   CORP  ",
      JSON.stringify(leadsOwner.body?.items),
    );
    check(
      "growth: leads row exposes NO requester identity field",
      leadsOwner.status === 200 &&
        JSON.stringify(Object.keys(leadsOwner.body?.items?.[0] ?? {}).sort()) ===
          JSON.stringify(["businessName", "city", "createdAt", "message"]),
      JSON.stringify(Object.keys(leadsOwner.body?.items?.[0] ?? {})),
    );

    // Cross-tenant isolation, mirroring /demand's own proof.
    const leadsContoso = await req("GET", "/rpc/growth/leads", {
      slug: "contoso",
      cookie: contosoOwnerCk,
    });
    check(
      "growth: contoso NEVER sees acme's lead rows (200, empty)",
      leadsContoso.status === 200 &&
        leadsContoso.body?.items?.length === 0 &&
        leadsContoso.body?.meta?.totalItems === 0,
      JSON.stringify(leadsContoso.body),
    );

    // ── Phase 6 (growth-loop-hardening): post-lead "we'll notify you"
    //    follow-up. Publishing acme's landing page must email the ONE
    //    non-anonymous matched lead's requester exactly once, and mark that
    //    lead's notifiedAt — never touching the anonymous "Some Other Cafe"
    //    lead, which names a business nobody owns. onPublish is fire-and-
    //    forget (`void onPublish(...).catch(...)`), so captureEmailSends
    //    waits briefly after the response for it to actually run.
    const { result: publishRes, sentTo } = await captureEmailSends(() =>
      req("POST", "/rpc/landing-page/publish", { slug: "acme", cookie: ownerCk }),
    );
    check(
      "growth: owner publishes acme's landing page (200)",
      publishRes.status === 200,
      `status ${publishRes.status}`,
    );
    check(
      "growth: publishing notifies the matched lead's requester exactly once",
      sentTo.length === 1 && sentTo[0] === growthCustomer!.email,
      JSON.stringify(sentTo),
    );

    const [notifiedLead] = await adminDb
      .select({ notifiedAt: chronoBusinessLead.notifiedAt })
      .from(chronoBusinessLead)
      .where(eq(chronoBusinessLead.businessNameNormalized, "acme corp"));
    check(
      "growth: the matched lead's notifiedAt is now set",
      notifiedLead?.notifiedAt instanceof Date,
      JSON.stringify(notifiedLead),
    );

    // Republishing must NOT send a second email — the notifiedAt guard.
    const { sentTo: sentToOnRepublish } = await captureEmailSends(() =>
      req("POST", "/rpc/landing-page/publish", { slug: "acme", cookie: ownerCk }),
    );
    check(
      "growth: republishing sends NO second email to the already-notified lead",
      sentToOnRepublish.length === 0,
      JSON.stringify(sentToOnRepublish),
    );

    // ── Phase 7 (growth-loop-hardening): the onboarding checklist response
    //    itself must NEVER carry a demand-count-shaped field — the whole
    //    point of fetching it via a SEPARATE `GET /rpc/growth/demand` call
    //    instead of threading it through `resolveOnboardingState()`'s
    //    non-strict Zod parse (which would otherwise silently strip an
    //    unrecognized key, masking a regression). Proven for both roles: a
    //    non-admin staff viewer must never see it, and neither should an
    //    admin — this response shape carries no such field at all.
    const checklistOwner = await req("GET", "/rpc/onboarding/checklist", {
      slug: "acme",
      cookie: ownerCk,
    });
    const checklistStaff = await req("GET", "/rpc/onboarding/checklist", {
      slug: "acme",
      cookie: staffCk,
    });
    check(
      "onboarding: checklist response (owner) carries no demandCount-shaped field",
      checklistOwner.status === 200 &&
        !Object.keys(checklistOwner.body ?? {}).some((k) => /demand/i.test(k)),
      JSON.stringify(Object.keys(checklistOwner.body ?? {})),
    );
    check(
      "onboarding: checklist response (staff) carries no demandCount-shaped field",
      checklistStaff.status === 200 &&
        !Object.keys(checklistStaff.body ?? {}).some((k) => /demand/i.test(k)),
      JSON.stringify(Object.keys(checklistStaff.body ?? {})),
    );
  }

  // ── Company inquiry (Phase 8, growth-loop-hardening): the row persists
  //    FIRST, even when the email send subsequently fails. A real send
  //    failure is simulated — not just the pre-existing missing-
  //    SUPPORT_INBOX_EMAIL config throw — by monkey-patching the process-
  //    wide cached sender's own `.send` (getEmailSender() memoizes a single
  //    instance for the process, so EMAIL_PROVIDER alone can't be swapped
  //    this late — every earlier test in this run already forced it to
  //    "console"). The caller-visible failure behavior (a 5xx) must stay
  //    exactly what it was before this phase. ──
  {
    const { getEmailSender } = await import("agora/server");
    const prevInbox = process.env.SUPPORT_INBOX_EMAIL;
    process.env.SUPPORT_INBOX_EMAIL = "support@example.com";

    const sender = getEmailSender();
    const originalSend = sender.send.bind(sender);
    sender.send = async () => {
      throw new Error("simulated email-provider failure");
    };

    const inquiryEmail = `inquiry-${createId()}@example.com`;
    const failedInquiry = await req("POST", "/public/company-inquiries", {
      json: {
        name: "Provider Failure Tester",
        email: inquiryEmail,
        requestType: "Demo",
        message: "Testing provider failure persistence.",
        source: "support",
      },
    });

    sender.send = originalSend;
    process.env.SUPPORT_INBOX_EMAIL = prevInbox;

    check(
      "company-inquiry: a real email-provider failure still surfaces as an error to the caller (unchanged behavior)",
      failedInquiry.status >= 500,
      `status ${failedInquiry.status}`,
    );

    const [persistedInquiry] = await adminDb
      .select({ email: chronoCompanyInquiry.email })
      .from(chronoCompanyInquiry)
      .where(eq(chronoCompanyInquiry.email, inquiryEmail));
    check(
      "company-inquiry: the row still exists despite the email send failure",
      persistedInquiry?.email === inquiryEmail,
      JSON.stringify(persistedInquiry),
    );
  }

  // ── U. Tenant lifecycle: suspend blocks non-owner staff + customers; owner
  //     retains access; resume restores everyone. ──
  const suspend = await req("POST", "/rpc/tenant/suspend", { slug: "acme", cookie: ownerCk });
  check("owner suspends business (200)", suspend.status === 200, `status ${suspend.status}`);

  const staffSuspended = await req("GET", "/rpc/me", { slug: "acme", cookie: staffCk });
  check(
    "non-owner staff blocked on suspended tenant (403 WORKSPACE_SUSPENDED)",
    staffSuspended.status === 403 && staffSuspended.body?.error === WORKSPACE_SUSPENDED,
    `status ${staffSuspended.status} ${JSON.stringify(staffSuspended.body)}`,
  );

  const custSuspended = await req("POST", "/portal/auth/sign-in", {
    slug: "acme",
    json: { email: "cust@acme.test", password: NEWPW },
  });
  check(
    "customer sign-in blocked on suspended tenant (403)",
    custSuspended.status === 403,
    `status ${custSuspended.status} ${JSON.stringify(custSuspended.body)}`,
  );

  const ownerWhileSuspended = await req("GET", "/rpc/me", { slug: "acme", cookie: ownerCk });
  check(
    "owner retains access on suspended tenant (200)",
    ownerWhileSuspended.status === 200,
    `status ${ownerWhileSuspended.status}`,
  );

  const staffSuspendAttempt = await req("POST", "/rpc/tenant/suspend", { slug: "acme", cookie: staffCk });
  check(
    "non-owner cannot suspend (403)",
    staffSuspendAttempt.status === 403,
    `status ${staffSuspendAttempt.status}`,
  );

  const resume = await req("POST", "/rpc/tenant/resume", { slug: "acme", cookie: ownerCk });
  check("owner resumes business (200)", resume.status === 200, `status ${resume.status}`);
  const staffAfterResume = await req("GET", "/rpc/me", { slug: "acme", cookie: staffCk });
  check(
    "staff access restored after resume (200)",
    staffAfterResume.status === 200,
    `status ${staffAfterResume.status}`,
  );

  // ── U1. Tenant self-service General settings: view + rename organization.name
  //     (owner-only, tenant:read / tenant:update — same owner-only precedent as
  //     tenant lifecycle above). Role gate + cross-tenant isolation. ──
  const orgGetOwner = await req("GET", "/rpc/organization", { slug: "acme", cookie: ownerCk });
  check(
    "owner reads organization (200, name Acme Corp)",
    orgGetOwner.status === 200 && orgGetOwner.body?.organization?.name === "Acme Corp",
    `status ${orgGetOwner.status} ${JSON.stringify(orgGetOwner.body)}`,
  );

  const orgGetStaff = await req("GET", "/rpc/organization", { slug: "acme", cookie: staffCk });
  check("staff blocked from organization read (403)", orgGetStaff.status === 403, `status ${orgGetStaff.status}`);
  const orgGetAdmin = await req("GET", "/rpc/organization", { slug: "acme", cookie: adminCk });
  check("admin blocked from organization read (403)", orgGetAdmin.status === 403, `status ${orgGetAdmin.status}`);

  // Role gate: neither staff nor admin may rename the business.
  const orgPatchStaff = await req("PATCH", "/rpc/organization", {
    slug: "acme",
    cookie: staffCk,
    json: { name: "Staff Attempted Rename" },
  });
  check(
    "staff blocked from organization rename (403)",
    orgPatchStaff.status === 403,
    `status ${orgPatchStaff.status}`,
  );
  const orgPatchAdmin = await req("PATCH", "/rpc/organization", {
    slug: "acme",
    cookie: adminCk,
    json: { name: "Admin Attempted Rename" },
  });
  check(
    "admin blocked from organization rename (403)",
    orgPatchAdmin.status === 403,
    `status ${orgPatchAdmin.status}`,
  );

  // Happy path: owner renames.
  const orgPatchOwner = await req("PATCH", "/rpc/organization", {
    slug: "acme",
    cookie: ownerCk,
    json: { name: "Acme Corp Renamed" },
  });
  check(
    "owner renames organization (200, renamed)",
    orgPatchOwner.status === 200 && orgPatchOwner.body?.organization?.name === "Acme Corp Renamed",
    `status ${orgPatchOwner.status} ${JSON.stringify(orgPatchOwner.body)}`,
  );
  const orgGetAfterRename = await req("GET", "/rpc/organization", { slug: "acme", cookie: ownerCk });
  check(
    "rename persisted on reread (200, Acme Corp Renamed)",
    orgGetAfterRename.status === 200 &&
      orgGetAfterRename.body?.organization?.name === "Acme Corp Renamed",
    `status ${orgGetAfterRename.status} ${JSON.stringify(orgGetAfterRename.body)}`,
  );

  // Cross-tenant isolation: contoso's own name is untouched by acme's rename.
  const orgGetContoso = await req("GET", "/rpc/organization", {
    slug: "contoso",
    cookie: contosoOwnerCk,
  });
  check(
    "contoso organization unaffected by acme's rename (still Contoso Ltd)",
    orgGetContoso.status === 200 && orgGetContoso.body?.organization?.name === "Contoso Ltd",
    `status ${orgGetContoso.status} ${JSON.stringify(orgGetContoso.body)}`,
  );

  // ── V. Tenant export contains ONLY the tenant's rows (isolation). ──
  const exp = await req("GET", "/rpc/tenant/export", { slug: "acme", cookie: ownerCk });
  check(
    "owner exports tenant (200, slug acme)",
    exp.status === 200 && exp.body?.tenant?.slug === "acme",
    `status ${exp.status} ${JSON.stringify(exp.body?.tenant)}`,
  );
  const exportData = (exp.body?.data ?? {}) as Record<string, Array<{ tenantId?: string }>>;
  const allRows = Object.values(exportData).flat();
  check(
    "export includes at least the acme project row",
    (exportData["Projects"] ?? []).some((r) => r.tenantId === acmeId),
    JSON.stringify(exportData["Projects"]),
  );
  check(
    "export contains ONLY acme rows (no contoso, every row tenantId=acme)",
    allRows.length > 0 && allRows.every((r) => r.tenantId === acmeId) &&
      !allRows.some((r) => r.tenantId === contosoId),
    `rows ${allRows.length}`,
  );
  check(
    "export redacts customer password hash",
    (exportData["TenantMembers"] ?? []).every(
      (r) => (r as { passwordHash?: string }).passwordHash === "[redacted]",
    ),
    JSON.stringify(exportData["TenantMembers"]),
  );
  const expStaff = await req("GET", "/rpc/tenant/export", { slug: "acme", cookie: staffCk });
  check("non-owner blocked from export (403)", expStaff.status === 403, `status ${expStaff.status}`);

  // ── W. DSAR: list / export / delete a single customer (admin+). ──
  const custList = await req("GET", "/rpc/customers", { slug: "acme", cookie: ownerCk });
  const custRow = (custList.body?.items ?? []).find(
    (m: any) => m.email === "cust@acme.test",
  );
  check("admin lists customers incl. cust@acme.test", !!custRow, JSON.stringify(custList.body?.items));

  const custListStaff = await req("GET", "/rpc/customers", { slug: "acme", cookie: staffCk });
  check("non-admin blocked from customer list (403)", custListStaff.status === 403, `status ${custListStaff.status}`);

  const custExport = await req("GET", `/rpc/customers/${custRow?.id}/export`, {
    slug: "acme",
    cookie: ownerCk,
  });
  check(
    "admin exports a single customer (200, redacted)",
    custExport.status === 200 &&
      custExport.body?.member?.email === "cust@acme.test" &&
      custExport.body?.member?.passwordHash === "[redacted]",
    `status ${custExport.status} ${JSON.stringify(custExport.body?.member)}`,
  );

  const custDel = await req("DELETE", `/rpc/customers/${custRow?.id}`, { slug: "acme", cookie: ownerCk });
  check("admin deletes a customer (200)", custDel.status === 200, `status ${custDel.status}`);
  const custListAfter = await req("GET", "/rpc/customers", { slug: "acme", cookie: ownerCk });
  check(
    "deleted customer no longer listed",
    !(custListAfter.body?.items ?? []).some((m: any) => m.email === "cust@acme.test"),
    JSON.stringify(custListAfter.body?.items),
  );

  // ── W. Platform admin portal (cross-tenant, permission-gated, no tenant
  //     context — independent of the staff role ladder above). ──
  const platformAdminUser = await ensureStaff("platform-admin@e2e.test", "Platform Admin");
  const platformViewerUser = await ensureStaff("platform-viewer@e2e.test", "Platform Viewer");
  await adminDb
    .update(schema.user)
    .set({ platformRole: "admin", role: "impersonator" })
    .where(eq(schema.user.id, platformAdminUser));
  await adminDb
    .update(schema.user)
    .set({ platformRole: "viewer", role: null })
    .where(eq(schema.user.id, platformViewerUser));
  const platformAdminCk = await staffCookie("platform-admin@e2e.test");
  const platformViewerCk = await staffCookie("platform-viewer@e2e.test");
  const HDR = { "x-platform-admin": "1" };

  const meAdmin = await req("GET", "/rpc-admin/me", { cookie: platformAdminCk });
  check(
    "platform admin /me reports role + full permissions",
    meAdmin.status === 200 &&
      meAdmin.body?.platformRole === "admin" &&
      ["read", "suspend", "resume"].every((a) =>
        (meAdmin.body?.permissions?.organization ?? []).includes(a),
      ),
    JSON.stringify(meAdmin.body),
  );

  const meViewer = await req("GET", "/rpc-admin/me", { cookie: platformViewerCk });
  check(
    "platform viewer /me reports read-only permissions",
    meViewer.status === 200 &&
      meViewer.body?.platformRole === "viewer" &&
      (meViewer.body?.permissions?.organization ?? []).includes("read") &&
      !(meViewer.body?.permissions?.organization ?? []).includes("suspend"),
    JSON.stringify(meViewer.body),
  );

  const meOrdinaryStaff = await req("GET", "/rpc-admin/me", { cookie: ownerCk });
  check(
    "ordinary tenant owner has no platform role — /me reports null, never throws",
    meOrdinaryStaff.status === 200 && meOrdinaryStaff.body?.platformRole === null,
    JSON.stringify(meOrdinaryStaff.body),
  );

  const meNoSession = await req("GET", "/rpc-admin/me", {});
  check(
    "unauthenticated /me reports null rather than 401",
    meNoSession.status === 200 && meNoSession.body?.platformRole === null,
    `status ${meNoSession.status}`,
  );

  const listAsAdmin = await req("GET", "/rpc-admin/organizations", { cookie: platformAdminCk });
  check(
    "platform admin lists every organization (cross-tenant)",
    listAsAdmin.status === 200 &&
      (listAsAdmin.body?.items ?? []).some((o: any) => o.id === acmeId) &&
      (listAsAdmin.body?.items ?? []).some((o: any) => o.id === contosoId),
    JSON.stringify(listAsAdmin.body),
  );

  // Chrono's onboarding registry (platform-admin-onboarding-progress plan) is
  // wired into platformAdminRoutes — every row must carry the real 7-item
  // checklist's total, not the foundation's empty-registry {0,0}. Without
  // this, a silently-broken wiring (field always {0,0}, or never called)
  // would pass the enforced gate green.
  check(
    "every org list row carries the Chrono onboarding registry (total 7, not the empty foundation default)",
    listAsAdmin.status === 200 &&
      (listAsAdmin.body?.items ?? []).length > 0 &&
      (listAsAdmin.body?.items ?? []).every((o: any) => o.onboarding?.total === 7),
    JSON.stringify(listAsAdmin.body?.items?.map((o: any) => ({ id: o.id, onboarding: o.onboarding }))),
  );

  const listAsViewer = await req("GET", "/rpc-admin/organizations", { cookie: platformViewerCk });
  check("platform viewer may also list (read-only permission)", listAsViewer.status === 200);

  const listAsOrdinary = await req("GET", "/rpc-admin/organizations", { cookie: ownerCk });
  check(
    "tenant owner with no platform role is blocked from the list (403)",
    listAsOrdinary.status === 403,
    `status ${listAsOrdinary.status}`,
  );

  const suspendNoHeader = await req("POST", `/rpc-admin/organizations/${contosoId}/suspend`, {
    cookie: platformAdminCk,
  });
  check(
    "suspend without the CSRF-preflight header is rejected (400)",
    suspendNoHeader.status === 400,
    `status ${suspendNoHeader.status}`,
  );

  const suspendAsViewer = await req("POST", `/rpc-admin/organizations/${contosoId}/suspend`, {
    cookie: platformViewerCk,
    headers: HDR,
  });
  check(
    "viewer role cannot suspend — read does not imply suspend (403)",
    suspendAsViewer.status === 403,
    `status ${suspendAsViewer.status}`,
  );

  const suspendAsAdmin = await req("POST", `/rpc-admin/organizations/${contosoId}/suspend`, {
    cookie: platformAdminCk,
    headers: HDR,
  });
  check(
    "platform admin suspends contoso",
    suspendAsAdmin.status === 200 && suspendAsAdmin.body?.status === "suspended",
    JSON.stringify(suspendAsAdmin.body),
  );

  const contosoOwnerBlocked = await req("GET", "/rpc/me", { slug: "contoso", cookie: contosoOwnerCk });
  check(
    "contoso's owner retains dashboard access while suspended (accepted MVP limitation)",
    contosoOwnerBlocked.status === 200,
    `status ${contosoOwnerBlocked.status}`,
  );

  const acmeUnaffected = await req("GET", "/rpc/me", { slug: "acme", cookie: ownerCk });
  check(
    "suspending contoso does not affect acme (isolation-analog)",
    acmeUnaffected.status === 200,
    `status ${acmeUnaffected.status}`,
  );

  const resumeAsAdmin = await req("POST", `/rpc-admin/organizations/${contosoId}/resume`, {
    cookie: platformAdminCk,
    headers: HDR,
  });
  check(
    "platform admin resumes contoso",
    resumeAsAdmin.status === 200 && resumeAsAdmin.body?.status === "active",
    JSON.stringify(resumeAsAdmin.body),
  );

  // ── W1a2. Organizations management: Edit / Archive / Reactivate / Change
  //          Plan — each gated on its own permission, with role gate + a
  //          cross-tenant isolation check. Runs on contoso (acme's pro state is
  //          reserved for the override block below). ──
  const editAsViewer = await req("PATCH", `/rpc-admin/organizations/${contosoId}`, {
    cookie: platformViewerCk,
    headers: HDR,
    json: { name: "Contoso Renamed" },
  });
  check(
    "viewer cannot edit an org — read does not imply edit (403)",
    editAsViewer.status === 403,
    `status ${editAsViewer.status}`,
  );
  const editAsAdmin = await req("PATCH", `/rpc-admin/organizations/${contosoId}`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: {
      name: "Contoso Renamed",
      tenantType: "internal",
      contactEmail: "ops@contoso.test",
    },
  });
  check("platform admin edits contoso (200)", editAsAdmin.status === 200, JSON.stringify(editAsAdmin.body));
  const contosoDetail = await req("GET", `/rpc-admin/organizations/${contosoId}`, {
    cookie: platformAdminCk,
  });
  check(
    "edit persisted name/tenantType/contact + detail exposes owner",
    contosoDetail.status === 200 &&
      contosoDetail.body?.name === "Contoso Renamed" &&
      contosoDetail.body?.tenantType === "internal" &&
      contosoDetail.body?.contactEmail === "ops@contoso.test" &&
      contosoDetail.body?.owner?.email &&
      typeof contosoDetail.body?.estMrr === "number",
    JSON.stringify(contosoDetail.body),
  );

  const CHRONO_ONBOARDING_KEYS = [
    "createBranch",
    "addStationGroup",
    "addStation",
    "inviteStaff",
    "addProducts",
    "pairDevice",
    "openShift",
  ];
  check(
    "org detail's onboarding.items names all seven Chrono checklist keys",
    contosoDetail.status === 200 &&
      contosoDetail.body?.onboarding?.total === 7 &&
      Array.isArray(contosoDetail.body?.onboarding?.items) &&
      contosoDetail.body.onboarding.items.length === 7 &&
      CHRONO_ONBOARDING_KEYS.every((key) =>
        contosoDetail.body.onboarding.items.some((i: any) => i.key === key),
      ),
    JSON.stringify(contosoDetail.body?.onboarding),
  );

  const archiveAsViewer = await req("POST", `/rpc-admin/organizations/${contosoId}/archive`, {
    cookie: platformViewerCk,
    headers: HDR,
  });
  check(
    "viewer cannot archive an org (403)",
    archiveAsViewer.status === 403,
    `status ${archiveAsViewer.status}`,
  );
  const archiveAsAdmin = await req("POST", `/rpc-admin/organizations/${contosoId}/archive`, {
    cookie: platformAdminCk,
    headers: HDR,
  });
  check(
    "platform admin archives contoso (200 + status archived)",
    archiveAsAdmin.status === 200 && archiveAsAdmin.body?.status === "archived",
    JSON.stringify(archiveAsAdmin.body),
  );
  const acmeUnaffectedByArchive = await req("GET", "/rpc/me", { slug: "acme", cookie: ownerCk });
  check(
    "archiving contoso does not affect acme (isolation)",
    acmeUnaffectedByArchive.status === 200,
    `status ${acmeUnaffectedByArchive.status}`,
  );
  const reactivateAsAdmin = await req("POST", `/rpc-admin/organizations/${contosoId}/reactivate`, {
    cookie: platformAdminCk,
    headers: HDR,
  });
  check(
    "platform admin reactivates contoso (200 + status active)",
    reactivateAsAdmin.status === 200 && reactivateAsAdmin.body?.status === "active",
    JSON.stringify(reactivateAsAdmin.body),
  );
  const contosoAfterReactivate = await req("GET", `/rpc-admin/organizations/${contosoId}`, {
    cookie: platformAdminCk,
  });
  check(
    "reactivate cleared archivedAt",
    contosoAfterReactivate.status === 200 && contosoAfterReactivate.body?.archivedAt === null,
    JSON.stringify(contosoAfterReactivate.body?.archivedAt),
  );

  const planAsViewer = await req("PATCH", `/rpc-admin/organizations/${contosoId}/plan`, {
    cookie: platformViewerCk,
    headers: HDR,
    json: { planId: "pro" },
  });
  check(
    "viewer cannot change plan — read does not imply override_subscription (403)",
    planAsViewer.status === 403,
    `status ${planAsViewer.status}`,
  );
  const planAsAdmin = await req("PATCH", `/rpc-admin/organizations/${contosoId}/plan`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { planId: "pro" },
  });
  check("platform admin changes contoso plan to pro (200)", planAsAdmin.status === 200, JSON.stringify(planAsAdmin.body));
  const contosoPlanDetail = await req("GET", `/rpc-admin/organizations/${contosoId}`, {
    cookie: platformAdminCk,
  });
  check(
    "change-plan applied via the manual-override write path (pro + manualOverride)",
    contosoPlanDetail.body?.subscription?.plan === "pro" &&
      contosoPlanDetail.body?.subscription?.manualOverride === true &&
      contosoPlanDetail.body?.planId === "pro",
    JSON.stringify(contosoPlanDetail.body?.subscription),
  );
  // Restore contoso to a no-subscription state so no later block inherits the
  // override row (a downstream block plain-inserts contoso's subscription and
  // would hit tenant_subscription_tenant_uq otherwise).
  await withTenant(contosoId, (tx) => tx.delete(tenantSubscription));

  // ── W1b. Manual subscription override: atomic webhook suppression,
  //        pending-sync catch-up on clear, role gate, cross-tenant isolation. ──
  // acme currently holds the "pro"/active/20-seats state landed by the earlier
  // signed-webhook test (block U).
  const overrideBody = {
    plan: "enterprise" as const,
    seats: -1,
    status: "active" as const,
    reason: "e2e: comped for enterprise pilot",
  };

  const overrideNoHeader = await req(
    "PATCH",
    `/rpc-admin/organizations/${acmeId}/subscription/override`,
    { cookie: platformAdminCk, json: overrideBody },
  );
  check(
    "override without the CSRF-preflight header is rejected (400)",
    overrideNoHeader.status === 400,
    `status ${overrideNoHeader.status}`,
  );

  const overrideAsViewer = await req(
    "PATCH",
    `/rpc-admin/organizations/${acmeId}/subscription/override`,
    { cookie: platformViewerCk, headers: HDR, json: overrideBody },
  );
  check(
    "viewer role cannot set an override — read does not imply override_subscription (403)",
    overrideAsViewer.status === 403,
    `status ${overrideAsViewer.status}`,
  );

  const overrideMissingReason = await req(
    "PATCH",
    `/rpc-admin/organizations/${acmeId}/subscription/override`,
    {
      cookie: platformAdminCk,
      headers: HDR,
      json: { ...overrideBody, reason: "" },
    },
  );
  check(
    "empty reason is rejected (400)",
    overrideMissingReason.status === 400,
    `status ${overrideMissingReason.status}`,
  );

  const overrideAsAdmin = await req(
    "PATCH",
    `/rpc-admin/organizations/${acmeId}/subscription/override`,
    { cookie: platformAdminCk, headers: HDR, json: overrideBody },
  );
  check(
    "platform admin sets an override on acme",
    overrideAsAdmin.status === 200 && overrideAsAdmin.body?.ok === true,
    JSON.stringify(overrideAsAdmin.body),
  );

  // tenantSubscriptionEvent (Phase 2): setManualOverride's own upsert writes
  // a `source: "manual_override"` history row for the pro→enterprise change.
  const acmeEventsAfterOverride = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantSubscriptionEvent).where(eq(tenantSubscriptionEvent.tenantId, acmeId)),
  );
  check(
    "setManualOverride writes a manual_override history row (pro → enterprise)",
    acmeEventsAfterOverride.some(
      (e) => e.source === "manual_override" && e.previousPlan === "pro" && e.newPlan === "enterprise",
    ),
    `got ${JSON.stringify(acmeEventsAfterOverride)}`,
  );
  const acmeEventCountAfterOverride = acmeEventsAfterOverride.length;

  const orgAfterOverride = await req("GET", `/rpc-admin/organizations/${acmeId}`, {
    cookie: platformAdminCk,
  });
  check(
    "GET org detail reflects the override (plan/seats/manualOverride/reason/actor)",
    orgAfterOverride.status === 200 &&
      orgAfterOverride.body?.subscription?.plan === "enterprise" &&
      orgAfterOverride.body?.subscription?.seats === -1 &&
      orgAfterOverride.body?.subscription?.manualOverride === true &&
      orgAfterOverride.body?.subscription?.overrideReason === overrideBody.reason &&
      orgAfterOverride.body?.subscription?.overrideBy === "platform-admin@e2e.test",
    JSON.stringify(orgAfterOverride.body?.subscription),
  );

  // ── FM. Global feature management (feature_definition config) ─────────────
  // Resolution order (first match wins): kill switch → per-tenant override →
  // plan availability → rollout → global default. acme holds a per-tenant
  // override (enabled=true) on example.beta_dashboard from the FF block above.
  const GKEY = "example.advanced_export"; // no tenant overrides
  const KILLKEY = "example.beta_dashboard"; // acme override = true
  const ROLLKEY = "reports.advanced";
  const ffCookies = { slug: "acme", cookie: ownerCk };

  // Read: viewer can list global configs (featureFlag:read).
  const fmList = await req("GET", "/rpc-admin/feature-flags", {
    cookie: platformViewerCk,
  });
  const fmListKill = (fmList.body?.items ?? []).find((i: any) => i.key === KILLKEY);
  check(
    "feature list readable by viewer, with global config + override count",
    fmList.status === 200 &&
      Array.isArray(fmList.body?.items) &&
      fmListKill?.status === "active" &&
      fmListKill?.tenantOverrideCount >= 1,
    `status ${fmList.status} ${JSON.stringify(fmListKill)}`,
  );

  // Read: detail lists the override tenants + resolved value.
  const fmDetail = await req("GET", `/rpc-admin/feature-flags/${KILLKEY}`, {
    cookie: platformViewerCk,
  });
  const fmDetailAcme = (fmDetail.body?.tenantOverrides ?? []).find(
    (t: any) => t.tenantId === acmeId,
  );
  check(
    "feature detail lists acme's override (enabled + resolvedOn)",
    fmDetail.status === 200 &&
      fmDetailAcme?.enabled === true &&
      fmDetailAcme?.resolvedOn === true,
    `status ${fmDetail.status} ${JSON.stringify(fmDetailAcme)}`,
  );

  // Unknown key → 404.
  const fmUnknown = await req("GET", "/rpc-admin/feature-flags/nope.not_a_flag", {
    cookie: platformAdminCk,
  });
  check("unknown feature key detail is 404", fmUnknown.status === 404, `status ${fmUnknown.status}`);

  // Role gate: viewer cannot PATCH global config.
  const fmPatchViewer = await req("PATCH", `/rpc-admin/feature-flags/${GKEY}`, {
    cookie: platformViewerCk,
    headers: HDR,
    json: { globalDefault: true },
  });
  check("viewer blocked from PATCHing global config (403)", fmPatchViewer.status === 403, `status ${fmPatchViewer.status}`);

  // CSRF-preflight header required.
  const fmPatchNoHeader = await req("PATCH", `/rpc-admin/feature-flags/${GKEY}`, {
    cookie: platformAdminCk,
    json: { globalDefault: true },
  });
  check("PATCH without the preflight header is rejected (400)", fmPatchNoHeader.status === 400, `status ${fmPatchNoHeader.status}`);

  // Happy path: admin turns a feature ON globally (globalDefault) — resolves ON
  // for a tenant with no override, reason "default".
  const fmSetDefault = await req("PATCH", `/rpc-admin/feature-flags/${GKEY}`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { globalDefault: true },
  });
  check(
    "admin sets globalDefault=true (200, config reflects it)",
    fmSetDefault.status === 200 && fmSetDefault.body?.globalDefault === true,
    `status ${fmSetDefault.status} ${JSON.stringify(fmSetDefault.body)}`,
  );
  const fmDefaultResolved = await req("GET", "/rpc/features", ffCookies);
  const fmDefaultRow = (fmDefaultResolved.body?.features ?? []).find((f: any) => f.key === GKEY);
  check(
    "globalDefault=true resolves ON (reason default) for a tenant with no override",
    fmDefaultRow?.enabled === true && fmDefaultRow?.reason === "default",
    JSON.stringify(fmDefaultRow),
  );

  // #1 beats #2: kill switch forces OFF even with a per-tenant enable.
  const fmKill = await req("PATCH", `/rpc-admin/feature-flags/${KILLKEY}`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { status: "disabled" },
  });
  check("admin sets kill switch (status=disabled)", fmKill.status === 200 && fmKill.body?.status === "disabled", JSON.stringify(fmKill.body));
  const fmKilled = await req("GET", "/rpc/features", ffCookies);
  const fmKilledRow = (fmKilled.body?.features ?? []).find((f: any) => f.key === KILLKEY);
  check(
    "kill switch beats a per-tenant override (OFF, reason killed)",
    fmKilledRow?.enabled === false && fmKilledRow?.reason === "killed" && fmKilledRow?.override === true,
    JSON.stringify(fmKilledRow),
  );

  // Restore: re-activating honours the per-tenant override again (#2).
  const fmUnkill = await req("PATCH", `/rpc-admin/feature-flags/${KILLKEY}`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { status: "active" },
  });
  check("admin re-activates the feature", fmUnkill.status === 200 && fmUnkill.body?.status === "active", JSON.stringify(fmUnkill.body));
  const fmRestored = await req("GET", "/rpc/features", ffCookies);
  const fmRestoredRow = (fmRestored.body?.features ?? []).find((f: any) => f.key === KILLKEY);
  check(
    "after un-kill, the per-tenant override wins again (ON, reason override)",
    fmRestoredRow?.enabled === true && fmRestoredRow?.reason === "override",
    JSON.stringify(fmRestoredRow),
  );

  // Rollout is evaluated before the default and is deterministic. rollout=0 with
  // globalDefault=true → nobody is in the bucket, so OFF with reason "rollout".
  const fmRollout = await req("PATCH", `/rpc-admin/feature-flags/${ROLLKEY}`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { rolloutPercentage: 0, globalDefault: true },
  });
  check("admin sets rolloutPercentage=0 + globalDefault=true", fmRollout.status === 200, `status ${fmRollout.status}`);
  const fmRoll1 = await req("GET", "/rpc/features", ffCookies);
  const fmRoll1Row = (fmRoll1.body?.features ?? []).find((f: any) => f.key === ROLLKEY);
  const fmRoll2 = await req("GET", "/rpc/features", ffCookies);
  const fmRoll2Row = (fmRoll2.body?.features ?? []).find((f: any) => f.key === ROLLKEY);
  check(
    "rollout=0 beats globalDefault=true (OFF, reason rollout) and is deterministic",
    fmRoll1Row?.enabled === false &&
      fmRoll1Row?.reason === "rollout" &&
      fmRoll1Row?.enabled === fmRoll2Row?.enabled,
    JSON.stringify(fmRoll1Row),
  );

  // Cross-tenant: an explicit per-tenant override is independent. acme has NO
  // override on GKEY; set one (enabled=false) and it flips acme only, while
  // contoso still resolves the global default (true), reason default.
  const fmAcmeOverride = await req("PUT", `/rpc-admin/organizations/${acmeId}/feature-flags`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { key: GKEY, enabled: false },
  });
  check("admin sets acme per-tenant override false on GKEY", fmAcmeOverride.status === 200, `status ${fmAcmeOverride.status}`);
  const fmAcmeResolved = await req("GET", "/rpc/features", ffCookies);
  const fmAcmeRow = (fmAcmeResolved.body?.features ?? []).find((f: any) => f.key === GKEY);
  const fmContosoResolved = await req("GET", "/rpc/features", { slug: "contoso", cookie: contosoOwnerCk });
  const fmContosoRow = (fmContosoResolved.body?.features ?? []).find((f: any) => f.key === GKEY);
  check(
    "per-tenant override is cross-tenant independent (acme OFF, contoso ON by default)",
    fmAcmeRow?.enabled === false &&
      fmAcmeRow?.reason === "override" &&
      fmContosoRow?.enabled === true &&
      fmContosoRow?.reason === "default",
    `acme ${JSON.stringify(fmAcmeRow)} contoso ${JSON.stringify(fmContosoRow)}`,
  );

  // Audit: the global-config PATCH wrote platform.feature.globalConfigUpdated.
  const fmAudit = await req("GET", "/rpc-admin/audit?pageSize=100", { cookie: platformAdminCk });
  check(
    "global-config PATCH writes a platform.feature.globalConfigUpdated audit row",
    fmAudit.status === 200 &&
      (fmAudit.body?.items ?? []).some(
        (e: any) => e.action === "platform.feature.globalConfigUpdated" && e.targetId === GKEY,
      ),
    `status ${fmAudit.status}`,
  );

  // A signed webhook now arrives for acme with a DIFFERENT plan/status and a
  // NEW customer/subscription id. The atomic guard must suppress the state
  // fields (plan/status/seats/currentPeriodEnd) but still update identity
  // fields (customer/subscription id) — and must still record the event for
  // idempotency.
  const suppressedEvt = {
    id: "evt_e2e_acme_override_suppressed",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_e2e_acme_v2",
        customer: "cus_e2e_acme_v2",
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 86_400,
        metadata: { tenantId: acmeId, plan: "pro" },
      },
    },
  };
  const suppressedPayload = JSON.stringify(suppressedEvt);
  const suppressedSig = signStripePayload(suppressedPayload, "whsec_e2e_test_secret");
  const suppressedHook = await postHook(suppressedPayload, suppressedSig);
  check(
    "webhook while overridden is still accepted (200)",
    suppressedHook.status === 200 && suppressedHook.body?.received === true,
    JSON.stringify(suppressedHook.body),
  );

  const acmeSubAfterSuppressed = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantSubscription),
  );
  const suppressedRow = acmeSubAfterSuppressed[0];
  check(
    "atomic guard: plan/status/seats/manualOverride unchanged by the suppressed webhook",
    suppressedRow?.plan === "enterprise" &&
      suppressedRow?.status === "active" &&
      suppressedRow?.seats === -1 &&
      suppressedRow?.manualOverride === true,
    JSON.stringify(suppressedRow),
  );
  check(
    "identity fields are never suppressed: customer/subscription id updated",
    suppressedRow?.stripeCustomerId === "cus_e2e_acme_v2" &&
      suppressedRow?.stripeSubscriptionId === "sub_e2e_acme_v2",
    JSON.stringify(suppressedRow),
  );
  check(
    "pendingSync now holds the suppressed event's payload (plan/eventId, no seats)",
    !!suppressedRow?.pendingSync &&
      (suppressedRow.pendingSync as Record<string, unknown>).plan === "pro" &&
      (suppressedRow.pendingSync as Record<string, unknown>).eventId === suppressedEvt.id &&
      !("seats" in (suppressedRow.pendingSync as Record<string, unknown>)),
    JSON.stringify(suppressedRow?.pendingSync),
  );
  const suppressedIdemRow = await adminDb
    .select()
    .from(billingEvent)
    .where(eq(billingEvent.eventId, suppressedEvt.id));
  check(
    "the billingEvent idempotency row exists for the suppressed event (Stripe won't redeliver)",
    suppressedIdemRow.length === 1,
    `got ${suppressedIdemRow.length}`,
  );

  // tenantSubscriptionEvent (Phase 2): a webhook event suppressed by an
  // active manual override writes NO history row (no new row beyond the
  // manual_override one from setManualOverride above).
  const acmeEventsAfterSuppressed = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantSubscriptionEvent).where(eq(tenantSubscriptionEvent.tenantId, acmeId)),
  );
  check(
    "webhook suppressed by an active manual override writes no history row",
    acmeEventsAfterSuppressed.length === acmeEventCountAfterOverride,
    `got ${acmeEventsAfterSuppressed.length}, expected ${acmeEventCountAfterOverride}`,
  );

  // Replaying the same suppressed event is deduped, not re-suppressed.
  const replaySuppressed = await postHook(suppressedPayload, suppressedSig);
  check(
    "replaying the suppressed event is deduped (200)",
    replaySuppressed.status === 200 && replaySuppressed.body?.received === true,
    JSON.stringify(replaySuppressed.body),
  );

  // A TERMINAL event (subscription.deleted) arrives while still overridden.
  // Stripe's own idempotency means there is no "next" webhook to fall back
  // on — pending_sync + clear-time catch-up is the only recovery path.
  const terminalEvt = {
    id: "evt_e2e_acme_override_terminal",
    type: "customer.subscription.deleted",
    data: {
      object: {
        id: "sub_e2e_acme_v2",
        customer: "cus_e2e_acme_v2",
        status: "canceled",
        metadata: { tenantId: acmeId, plan: "pro" },
      },
    },
  };
  const terminalPayload = JSON.stringify(terminalEvt);
  const terminalSig = signStripePayload(terminalPayload, "whsec_e2e_test_secret");
  const terminalHook = await postHook(terminalPayload, terminalSig);
  check(
    "terminal webhook while overridden is accepted (200), still suppressed",
    terminalHook.status === 200 && terminalHook.body?.received === true,
    JSON.stringify(terminalHook.body),
  );

  const acmeSubAfterTerminal = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantSubscription),
  );
  const terminalRow = acmeSubAfterTerminal[0];
  check(
    "terminal webhook suppressed too: still enterprise/active; pendingSync now reflects the terminal (canceled) state",
    terminalRow?.plan === "enterprise" &&
      terminalRow?.manualOverride === true &&
      !!terminalRow?.pendingSync &&
      (terminalRow.pendingSync as Record<string, unknown>).status === "canceled" &&
      (terminalRow.pendingSync as Record<string, unknown>).eventId === terminalEvt.id,
    JSON.stringify(terminalRow?.pendingSync),
  );

  // Role gate on clear, same shape as set.
  const clearNoHeader = await req(
    "DELETE",
    `/rpc-admin/organizations/${acmeId}/subscription/override`,
    { cookie: platformAdminCk },
  );
  check(
    "clear without the CSRF-preflight header is rejected (400)",
    clearNoHeader.status === 400,
    `status ${clearNoHeader.status}`,
  );
  const clearAsViewer = await req(
    "DELETE",
    `/rpc-admin/organizations/${acmeId}/subscription/override`,
    { cookie: platformViewerCk, headers: HDR },
  );
  check(
    "viewer role cannot clear an override (403)",
    clearAsViewer.status === 403,
    `status ${clearAsViewer.status}`,
  );

  // Clear the override — the pending terminal event must be applied (the
  // suppressed-terminal-event recovery path), not silently lost.
  const clearAsAdmin = await req(
    "DELETE",
    `/rpc-admin/organizations/${acmeId}/subscription/override`,
    { cookie: platformAdminCk, headers: HDR },
  );
  check(
    "platform admin clears the override",
    clearAsAdmin.status === 200 && clearAsAdmin.body?.ok === true,
    JSON.stringify(clearAsAdmin.body),
  );

  const acmeSubAfterClear = await withTenant(acmeId, (tx) => tx.select().from(tenantSubscription));
  const clearedRow = acmeSubAfterClear[0];
  check(
    "clear applies the suppressed terminal event: plan reverts to pro, status canceled, pendingSync cleared",
    clearedRow?.plan === "pro" &&
      clearedRow?.status === "canceled" &&
      clearedRow?.manualOverride === false &&
      clearedRow?.overrideReason === null &&
      clearedRow?.overrideBy === null &&
      clearedRow?.overrideAt === null &&
      clearedRow?.pendingSync === null,
    JSON.stringify(clearedRow),
  );
  check(
    "seats re-derived from the landed plan (pro → 20), never carried in pendingSync",
    clearedRow?.seats === 20,
    `got ${clearedRow?.seats}`,
  );

  // tenantSubscriptionEvent (Phase 2): clearManualOverride writes a
  // `source: "override_cleared"` history row for enterprise → pro/canceled,
  // attributed to clear time (not the original suppressed-webhook time).
  const acmeEventsAfterClear = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantSubscriptionEvent).where(eq(tenantSubscriptionEvent.tenantId, acmeId)),
  );
  check(
    "clearManualOverride writes an override_cleared history row (enterprise → pro, active → canceled)",
    acmeEventsAfterClear.some(
      (e) =>
        e.source === "override_cleared" &&
        e.previousPlan === "enterprise" &&
        e.newPlan === "pro" &&
        e.previousStatus === "active" &&
        e.newStatus === "canceled",
    ),
    `got ${JSON.stringify(acmeEventsAfterClear)}`,
  );

  // Cross-tenant isolation for the new columns: setting/clearing an override
  // on acme must never touch contoso's row.
  const contosoSubAfterOverrideFlow = await withTenant(contosoId, (tx) =>
    tx.select().from(tenantSubscription),
  );
  check(
    "cross-tenant isolation: contoso's subscription row is untouched by acme's override flow",
    contosoSubAfterOverrideFlow.length === 0 ||
      (contosoSubAfterOverrideFlow[0]?.manualOverride === false &&
        contosoSubAfterOverrideFlow[0]?.pendingSync === null),
    JSON.stringify(contosoSubAfterOverrideFlow[0]),
  );

  // Not-found tenant still 404s, same as suspend/resume.
  const overrideMissingOrg = await req(
    "PATCH",
    `/rpc-admin/organizations/nonexistent-org-id/subscription/override`,
    { cookie: platformAdminCk, headers: HDR, json: overrideBody },
  );
  check(
    "override on a nonexistent org 404s",
    overrideMissingOrg.status === 404,
    `status ${overrideMissingOrg.status}`,
  );

  // Anti-escalation: a sign-up payload cannot self-grant a platform role — the
  // column is never a Better Auth `additionalFields` entry, so an extra field
  // in the request body is simply ignored.
  const escalationSignup = await req("POST", "/api/auth/sign-up/email", {
    json: {
      email: "escalation@e2e.test",
      password: PW,
      name: "Escalation Attempt",
      platformRole: "admin",
    },
  });
  check("escalation sign-up itself succeeds (200)", escalationSignup.status === 200);
  const escalationUser = await adminDb
    .select({ platformRole: schema.user.platformRole })
    .from(schema.user)
    .where(eq(schema.user.email, "escalation@e2e.test"));
  check(
    "sign-up payload cannot self-grant platformRole",
    escalationUser[0]?.platformRole == null,
    JSON.stringify(escalationUser[0]),
  );

  // ── W1c. Compliance tooling: platform-triggered tenant export + policy
  //        versioning. Seed one non-empty row directly for every
  //        secret-bearing table (webhook_endpoint, api_key,
  //        tenant_sso_connection, tenant_integration) so the redaction
  //        assertions below are non-vacuous regardless of what earlier
  //        blocks left behind (some clean up after themselves). ──
  await withTenant(acmeId, (tx) =>
    tx.insert(webhookEndpoint).values({
      id: createId(),
      tenantId: acmeId,
      url: "https://compliance-e2e.example.test/hook",
      secret: "whsec_compliance_e2e",
      events: ["project.created"],
    }),
  );
  await withTenant(acmeId, (tx) =>
    tx.insert(schema.apiKey).values({
      id: createId(),
      tenantId: acmeId,
      name: "compliance e2e key",
      prefix: "agora_e2e",
      keyHash: "deadbeef".repeat(8),
      role: "admin",
    }),
  );
  await withTenant(acmeId, (tx) =>
    tx.insert(tenantIntegration).values({
      id: createId(),
      tenantId: acmeId,
      category: "compliance-e2e",
      provider: "example",
      config: {},
      secretEnc: "encrypted:compliance-e2e-secret",
      enabled: false,
    }),
  );

  const exportNoHeader = await req(
    "POST",
    `/rpc-admin/organizations/${acmeId}/compliance/export`,
    { cookie: platformAdminCk, json: { reason: "e2e" } },
  );
  check(
    "export without the CSRF-preflight header is rejected (400)",
    exportNoHeader.status === 400,
    `status ${exportNoHeader.status}`,
  );

  const exportAsViewer = await req(
    "POST",
    `/rpc-admin/organizations/${acmeId}/compliance/export`,
    { cookie: platformViewerCk, headers: HDR, json: { reason: "e2e" } },
  );
  check(
    "viewer cannot trigger an export — read does not imply compliance:export (403)",
    exportAsViewer.status === 403,
    `status ${exportAsViewer.status}`,
  );

  const exportMissingOrg = await req(
    "POST",
    `/rpc-admin/organizations/nonexistent-org-id/compliance/export`,
    { cookie: platformAdminCk, headers: HDR, json: { reason: "e2e" } },
  );
  check(
    "export on a nonexistent org 404s",
    exportMissingOrg.status === 404,
    `status ${exportMissingOrg.status}`,
  );

  // A throwaway org in "deleting" status, used only to prove the 409 guard.
  const deletingOrgId = createId();
  await adminDb.insert(schema.organization).values({
    id: deletingOrgId,
    name: "Deleting Co",
    slug: `deleting-co-${Date.now()}`,
    status: "deleting",
  });
  const exportOnDeletingOrg = await req(
    "POST",
    `/rpc-admin/organizations/${deletingOrgId}/compliance/export`,
    { cookie: platformAdminCk, headers: HDR, json: { reason: "e2e" } },
  );
  check(
    "export against a deleting org is blocked (409)",
    exportOnDeletingOrg.status === 409,
    `status ${exportOnDeletingOrg.status}`,
  );
  await adminDb.delete(schema.organization).where(eq(schema.organization.id, deletingOrgId));

  const exportAsAdmin = await req(
    "POST",
    `/rpc-admin/organizations/${acmeId}/compliance/export`,
    { cookie: platformAdminCk, headers: HDR, json: { reason: "e2e: DSAR request" } },
  );
  check(
    "platform admin triggers acme's export (200, agora-tenant-export/v1)",
    exportAsAdmin.status === 200 && exportAsAdmin.body?.format === "agora-tenant-export/v1",
    `status ${exportAsAdmin.status} ${JSON.stringify(exportAsAdmin.body)?.slice(0, 300)}`,
  );

  const exportedWebhooks = (exportAsAdmin.body?.data?.WebhookEndpoints ?? []) as any[];
  check(
    "export non-vacuous: at least one webhook_endpoint row",
    exportedWebhooks.length > 0,
    `got ${exportedWebhooks.length}`,
  );
  check(
    "webhook_endpoint.secret is redacted in the export bundle",
    exportedWebhooks.length > 0 && exportedWebhooks.every((r) => r.secret === "[redacted]"),
    JSON.stringify(exportedWebhooks),
  );

  const exportedApiKeys = (exportAsAdmin.body?.data?.ApiKeys ?? []) as any[];
  check(
    "export non-vacuous: at least one api_key row",
    exportedApiKeys.length > 0,
    `got ${exportedApiKeys.length}`,
  );
  check(
    "api_key.keyHash is redacted in the export bundle",
    exportedApiKeys.length > 0 && exportedApiKeys.every((r) => r.keyHash === "[redacted]"),
    JSON.stringify(exportedApiKeys),
  );

  const exportedSso = (exportAsAdmin.body?.data?.TenantSsoConnections ?? []) as any[];
  check(
    "export non-vacuous: at least one tenant_sso_connection row",
    exportedSso.length > 0,
    `got ${exportedSso.length}`,
  );
  check(
    "tenant_sso_connection.clientSecretEnc is redacted in the export bundle",
    exportedSso.length > 0 && exportedSso.every((r) => r.clientSecretEnc === "[redacted]"),
    JSON.stringify(exportedSso),
  );

  const exportedIntegrations = (exportAsAdmin.body?.data?.TenantIntegrations ?? []) as any[];
  check(
    "export non-vacuous: at least one tenant_integration row",
    exportedIntegrations.length > 0,
    `got ${exportedIntegrations.length}`,
  );
  check(
    "tenant_integration.secretEnc is redacted in the export bundle",
    exportedIntegrations.length > 0 &&
      exportedIntegrations.every((r) => r.secretEnc === "[redacted]"),
    JSON.stringify(exportedIntegrations),
  );

  // Tenant's own self-service export must be redacted identically — the fix
  // in tenant-lifecycle/service.ts benefits both callers.
  const selfServiceExport = await req("GET", "/rpc/tenant/export", {
    slug: "acme",
    cookie: ownerCk,
  });
  const selfServiceWebhooks = (selfServiceExport.body?.data?.WebhookEndpoints ?? []) as any[];
  check(
    "self-service export also redacts webhook_endpoint.secret",
    selfServiceExport.status === 200 &&
      selfServiceWebhooks.length > 0 &&
      selfServiceWebhooks.every((r) => r.secret === "[redacted]"),
    JSON.stringify(selfServiceWebhooks),
  );

  // Dual-write audit: both the tenant's own auditEvent and platformAuditEvent
  // must record this export.
  const acmeAuditAfterExport = await withTenant(acmeId, (tx) =>
    tx
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.action, "tenant.exported_by_platform_admin")),
  );
  check(
    "tenant's own audit log records the platform-triggered export",
    acmeAuditAfterExport.length > 0,
    `got ${acmeAuditAfterExport.length}`,
  );

  const exportsHistoryAsViewer = await req(
    "GET",
    `/rpc-admin/organizations/${acmeId}/compliance/exports`,
    { cookie: platformViewerCk },
  );
  check(
    "viewer CAN read export history — gated on audit:read, not compliance:export (200)",
    exportsHistoryAsViewer.status === 200 &&
      (exportsHistoryAsViewer.body?.items ?? []).length > 0,
    `status ${exportsHistoryAsViewer.status} ${JSON.stringify(exportsHistoryAsViewer.body)}`,
  );
  check(
    "export history includes the reason from the triggering request",
    (exportsHistoryAsViewer.body?.items ?? []).some(
      (i: any) => i.reason === "e2e: DSAR request",
    ),
    JSON.stringify(exportsHistoryAsViewer.body?.items),
  );

  const exportsHistoryAsOrdinary = await req(
    "GET",
    `/rpc-admin/organizations/${acmeId}/compliance/exports`,
    { cookie: ownerCk },
  );
  check(
    "tenant owner (no platform role) is blocked from export history (403)",
    exportsHistoryAsOrdinary.status === 403,
    `status ${exportsHistoryAsOrdinary.status}`,
  );

  // ── W1d. Policy-version recording. ──
  const policyNoHeader = await req(
    "POST",
    `/rpc-admin/organizations/${acmeId}/compliance/policy`,
    { cookie: platformAdminCk, json: { policyType: "terms", version: "2025-01-01", acceptedAt: new Date().toISOString() } },
  );
  check(
    "policy record without the CSRF-preflight header is rejected (400)",
    policyNoHeader.status === 400,
    `status ${policyNoHeader.status}`,
  );

  const policyAsViewer = await req(
    "POST",
    `/rpc-admin/organizations/${acmeId}/compliance/policy`,
    {
      cookie: platformViewerCk,
      headers: HDR,
      json: { policyType: "terms", version: "2025-01-01", acceptedAt: new Date().toISOString() },
    },
  );
  check(
    "viewer cannot record a policy acceptance — policyRead does not imply policyManage (403)",
    policyAsViewer.status === 403,
    `status ${policyAsViewer.status}`,
  );

  const policyAsAdmin = await req(
    "POST",
    `/rpc-admin/organizations/${acmeId}/compliance/policy`,
    {
      cookie: platformAdminCk,
      headers: HDR,
      json: { policyType: "terms", version: "2025-01-01", acceptedAt: new Date().toISOString() },
    },
  );
  check(
    "platform admin records a policy acceptance for acme (200)",
    policyAsAdmin.status === 200 &&
      policyAsAdmin.body?.policyType === "terms" &&
      policyAsAdmin.body?.version === "2025-01-01",
    JSON.stringify(policyAsAdmin.body),
  );

  // A conflicting organizationId in the body (there is none in the schema —
  // proving instead that the path's :id, and only the path's :id, is ever
  // written to) still writes under acme, never contoso.
  const policyForContosoViaAcmePath = await req(
    "POST",
    `/rpc-admin/organizations/${acmeId}/compliance/policy`,
    {
      cookie: platformAdminCk,
      headers: HDR,
      json: {
        policyType: "privacy",
        version: "v2",
        acceptedAt: new Date().toISOString(),
        organizationId: contosoId,
      },
    },
  );
  check(
    "a body-supplied organizationId is ignored — the row is written under the path's :id",
    policyForContosoViaAcmePath.status === 200 &&
      policyForContosoViaAcmePath.body?.organizationId === acmeId,
    JSON.stringify(policyForContosoViaAcmePath.body),
  );

  const policyListForAcme = await req(
    "GET",
    `/rpc-admin/organizations/${acmeId}/compliance/policy`,
    { cookie: platformViewerCk },
  );
  check(
    "viewer can read acme's policy history (200)",
    policyListForAcme.status === 200 && (policyListForAcme.body?.items ?? []).length >= 2,
    JSON.stringify(policyListForAcme.body),
  );

  const policyListForContoso = await req(
    "GET",
    `/rpc-admin/organizations/${contosoId}/compliance/policy`,
    { cookie: platformViewerCk },
  );
  check(
    "cross-org isolation: contoso's policy list does not include acme's rows " +
      "(explicit organizationId filter, not RLS — this table is not tenant-scoped)",
    policyListForContoso.status === 200 &&
      !(policyListForContoso.body?.items ?? []).some((i: any) => i.organizationId === acmeId),
    JSON.stringify(policyListForContoso.body),
  );

  const policyListAsOrdinary = await req(
    "GET",
    `/rpc-admin/organizations/${acmeId}/compliance/policy`,
    { cookie: ownerCk },
  );
  check(
    "tenant owner (no platform role) is blocked from the policy list (403)",
    policyListAsOrdinary.status === 403,
    `status ${policyListAsOrdinary.status}`,
  );

  // ── W2. Platform sign-in methods (email / google / facebook). ──
  //
  // Real IdP consent cannot run here, so these prove everything up to the IdP
  // hop: the flag, the gate in front of Better Auth, each invariant, and the
  // fact that tenant authority grants no platform authority.
  //
  // Fixture: google has dummy credentials (configured), facebook has none
  // (unconfigured), email is always configured.
  // platform_auth_provider is PLATFORM-global: one switch for the whole
  // platform, with no tenant dimension. Adding it to the RLS set would be a
  // category error — every read runs on adminDb with no app.tenant_id set, so
  // a forced policy would make the table permanently invisible and lock the
  // platform out of its own sign-in configuration. Assert the constant
  // directly, so a later "add every table to APP_TENANT_TABLES" sweep fails
  // here rather than in production.
  check(
    "platform_auth_provider is NOT RLS-scoped (absent from both tenant table sets)",
    !(APP_TENANT_TABLES as readonly string[]).includes("PlatformAuthProviders") &&
      !(BASE_TENANT_TABLES as readonly string[]).includes("PlatformAuthProviders"),
    JSON.stringify({ APP_TENANT_TABLES, BASE_TENANT_TABLES }),
  );

  const AP = "/rpc-admin/auth-providers";
  const providerState = (body: any, id: string) =>
    (body?.providers ?? []).find((x: any) => x.id === id);

  const apAsAdmin = await req("GET", AP, { cookie: platformAdminCk });
  check(
    "platform admin reads sign-in methods (200, all three)",
    apAsAdmin.status === 200 && (apAsAdmin.body?.providers ?? []).length === 3,
    `status ${apAsAdmin.status} ${JSON.stringify(apAsAdmin.body)}`,
  );
  check(
    "email is configured and available",
    providerState(apAsAdmin.body, "email")?.configured === true &&
      providerState(apAsAdmin.body, "email")?.available === true,
    JSON.stringify(providerState(apAsAdmin.body, "email")),
  );
  check(
    "a configured, enabled provider is available",
    providerState(apAsAdmin.body, "google")?.configured === true &&
      providerState(apAsAdmin.body, "google")?.available === true,
    JSON.stringify(providerState(apAsAdmin.body, "google")),
  );
  check(
    "an UNCONFIGURED provider is unavailable even though its flag is enabled",
    providerState(apAsAdmin.body, "facebook")?.enabled === true &&
      providerState(apAsAdmin.body, "facebook")?.configured === false &&
      providerState(apAsAdmin.body, "facebook")?.available === false,
    JSON.stringify(providerState(apAsAdmin.body, "facebook")),
  );

  // Role gate.
  const apAsViewer = await req("GET", AP, { cookie: platformViewerCk });
  check("platform viewer reads sign-in methods (200)", apAsViewer.status === 200, `status ${apAsViewer.status}`);
  const apViewerWrite = await req("PATCH", `${AP}/google`, {
    cookie: platformViewerCk,
    headers: HDR,
    json: { enabled: false },
  });
  check(
    "platform viewer cannot change a sign-in method (403)",
    apViewerWrite.status === 403,
    `status ${apViewerWrite.status}`,
  );
  const apNoHeader = await req("PATCH", `${AP}/google`, {
    cookie: platformAdminCk,
    json: { enabled: false },
  });
  check(
    "sign-in method write without the CSRF-preflight header is rejected (400)",
    apNoHeader.status === 400,
    `status ${apNoHeader.status}`,
  );

  // Isolation reinterpretation for a NON-tenant-scoped resource: tenant
  // authority must grant no platform authority. An owner is the top of the
  // tenant ladder and must still be refused.
  const apAsOwner = await req("GET", AP, { cookie: ownerCk });
  check(
    "tenant owner cannot read platform sign-in methods (403)",
    apAsOwner.status === 403,
    `status ${apAsOwner.status}`,
  );
  const apOwnerWrite = await req("PATCH", `${AP}/google`, {
    cookie: ownerCk,
    headers: HDR,
    json: { enabled: false },
  });
  check(
    "tenant owner cannot change platform sign-in methods (403)",
    apOwnerWrite.status === 403,
    `status ${apOwnerWrite.status}`,
  );
  const apAsTenantStaff = await req("GET", AP, { cookie: staffCk, slug: "acme" });
  check(
    "tenant staff cannot read platform sign-in methods (403)",
    apAsTenantStaff.status === 403,
    `status ${apAsTenantStaff.status}`,
  );

  // Cannot enable a provider that has no OAuth credentials.
  const apEnableUnconfigured = await req("PATCH", `${AP}/facebook`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { enabled: true },
  });
  check(
    "enabling an unconfigured provider is refused (400)",
    apEnableUnconfigured.status === 400,
    `status ${apEnableUnconfigured.status} ${JSON.stringify(apEnableUnconfigured.body)}`,
  );

  // Self-lockout: the platform admin signs in with a password and holds no
  // Google account, so disabling email would leave THEM with no way in even
  // though the platform still has one.
  const apSelfLockout = await req("PATCH", `${AP}/email`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { enabled: false },
  });
  check(
    "an admin cannot disable their own last credential (400)",
    apSelfLockout.status === 400,
    `status ${apSelfLockout.status} ${JSON.stringify(apSelfLockout.body)}`,
  );

  // Disabling a provider takes effect at the auth boundary, not just in the UI.
  const disableGoogle = await req("PATCH", `${AP}/google`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { enabled: false },
  });
  check(
    "platform admin disables a sign-in method (200)",
    disableGoogle.status === 200 && providerState(disableGoogle.body, "google")?.available === false,
    `status ${disableGoogle.status} ${JSON.stringify(disableGoogle.body?.providers)}`,
  );
  const publicAfterDisable = await req("GET", "/public/auth-providers", {});
  check(
    "public discovery lists email and omits the disabled provider",
    publicAfterDisable.status === 200 &&
      publicAfterDisable.body?.email === true &&
      !(publicAfterDisable.body?.social ?? []).some((s: any) => s.id === "google"),
    JSON.stringify(publicAfterDisable.body),
  );
  const socialSignIn = await req("POST", "/api/auth/sign-in/social", {
    json: { provider: "google", callbackURL: "http://localtest.me:3000/auth/callback" },
  });
  check(
    "sign-in with a disabled provider is refused at the auth boundary (403)",
    socialSignIn.status === 403,
    `status ${socialSignIn.status} ${JSON.stringify(socialSignIn.body)}`,
  );
  const socialCallback = await req("GET", "/api/auth/callback/google?code=x&state=y", {});
  check(
    "the OAuth callback for a disabled provider is refused (403)",
    socialCallback.status === 403,
    `status ${socialCallback.status}`,
  );

  // With google off and facebook unconfigured, email is now the only available
  // method — the last-one guard must refuse to remove it.
  const apDisableEmail = await req("PATCH", `${AP}/email`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { enabled: false },
  });
  check(
    "disabling the last available sign-in method is refused (400)",
    apDisableEmail.status === 400,
    `status ${apDisableEmail.status} ${JSON.stringify(apDisableEmail.body)}`,
  );
  const apAfterRefusal = await req("GET", AP, { cookie: platformAdminCk });
  check(
    "a refused disable leaves no partial write behind",
    providerState(apAfterRefusal.body, "email")?.available === true,
    JSON.stringify(apAfterRefusal.body?.providers),
  );

  // Two concurrent disables of the only remaining method must not race past the
  // guard. CAVEAT: the enforced suite runs on PGlite, which serialises through a
  // single connection, so this proves the GUARD, not the advisory lock that
  // makes it hold under real concurrency. Run against TEST_DATABASE_URL on real
  // Postgres to exercise the lock itself.
  const [race1, race2] = await Promise.all([
    req("PATCH", `${AP}/email`, { cookie: platformAdminCk, headers: HDR, json: { enabled: false } }),
    req("PATCH", `${AP}/email`, { cookie: platformAdminCk, headers: HDR, json: { enabled: false } }),
  ]);
  const apAfterRace = await req("GET", AP, { cookie: platformAdminCk });
  check(
    "concurrent disables cannot empty the available set",
    race1.status === 400 &&
      race2.status === 400 &&
      (apAfterRace.body?.providers ?? []).some((x: any) => x.available === true),
    `statuses ${race1.status}/${race2.status} ${JSON.stringify(apAfterRace.body?.providers)}`,
  );

  // Re-enabling a configured provider restores it end to end.
  const reEnableGoogle = await req("PATCH", `${AP}/google`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { enabled: true },
  });
  check(
    "re-enabling a configured provider round-trips (200, available again)",
    reEnableGoogle.status === 200 && providerState(reEnableGoogle.body, "google")?.available === true,
    `status ${reEnableGoogle.status} ${JSON.stringify(reEnableGoogle.body?.providers)}`,
  );
  const publicAfterReEnable = await req("GET", "/public/auth-providers", {});
  check(
    "public discovery lists the re-enabled provider again",
    (publicAfterReEnable.body?.social ?? []).some((s: any) => s.id === "google"),
    JSON.stringify(publicAfterReEnable.body),
  );

  // Now prove the `email` branch of the gate actually fires. It could not be
  // exercised above: email was the only available method, so both the last-one
  // and self-lockout guards (correctly) refused to disable it. Give the admin a
  // google account row and google is a real fallback for them, so the disable
  // becomes legitimate — and the gate has to hold.
  await adminDb.insert(schema.account).values({
    id: createId(),
    accountId: "e2e-google-account",
    providerId: "google",
    userId: platformAdminUser,
  });
  const disableEmail = await req("PATCH", `${AP}/email`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { enabled: false },
  });
  check(
    "email can be disabled once another method covers the actor (200)",
    disableEmail.status === 200 && providerState(disableEmail.body, "email")?.available === false,
    `status ${disableEmail.status} ${JSON.stringify(disableEmail.body?.providers)}`,
  );
  const publicEmailOff = await req("GET", "/public/auth-providers", {});
  check(
    "public discovery reports email unavailable once disabled",
    publicEmailOff.body?.email === false,
    JSON.stringify(publicEmailOff.body),
  );
  const signInEmailOff = await req("POST", "/api/auth/sign-in/email", {
    json: { email: "owner@acme.test", password: "Password123!" },
  });
  check(
    "password sign-in is refused while email is disabled (403)",
    signInEmailOff.status === 403,
    `status ${signInEmailOff.status} ${JSON.stringify(signInEmailOff.body)}`,
  );
  // The whole password credential goes, not just the sign-in call — otherwise a
  // reset would re-establish exactly what the operator switched off.
  const forgotEmailOff = await req("POST", "/api/auth/forget-password", {
    json: { email: "owner@acme.test", redirectTo: "http://acme.localtest.me:3000/reset-password" },
  });
  check(
    "password reset is refused while email is disabled (403)",
    forgotEmailOff.status === 403,
    `status ${forgotEmailOff.status} ${JSON.stringify(forgotEmailOff.body)}`,
  );
  const twoFactorEmailOff = await req("POST", "/api/auth/two-factor/verify-totp", {
    json: { code: "000000" },
  });
  check(
    "two-factor verification is refused while email is disabled (403)",
    twoFactorEmailOff.status === 403,
    `status ${twoFactorEmailOff.status}`,
  );

  const reEnableEmail = await req("PATCH", `${AP}/email`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { enabled: true },
  });
  check(
    "re-enabling email restores it (200)",
    reEnableEmail.status === 200 && providerState(reEnableEmail.body, "email")?.available === true,
    `status ${reEnableEmail.status} ${JSON.stringify(reEnableEmail.body?.providers)}`,
  );

  // The gate must not break the method it protects.
  const forgotWhileEnabled = await req("POST", "/api/auth/forget-password", {
    json: { email: "owner@acme.test", redirectTo: "http://acme.localtest.me:3000/reset-password" },
  });
  check(
    "password reset stays reachable while email sign-in is enabled (not 403)",
    forgotWhileEnabled.status !== 403,
    `status ${forgotWhileEnabled.status}`,
  );

  // ── W2s. Platform System Settings (KV store, spec #14) — read/write gate,
  //     happy path, type/strict validation, critical-key audit, isolation. ──
  const SET = "/rpc-admin/settings";
  const settingVal = (body: any, key: string) =>
    (body?.settings ?? []).find((s: any) => s.key === key)?.value;

  // NOT RLS-scoped — must never enter either tenant table set.
  check(
    "platform_setting is NOT RLS-scoped (absent from both tenant table sets)",
    !(APP_TENANT_TABLES as readonly string[]).includes("PlatformSettings") &&
      !(BASE_TENANT_TABLES as readonly string[]).includes("PlatformSettings"),
    JSON.stringify({ APP_TENANT_TABLES, BASE_TENANT_TABLES }),
  );

  const setNoHeader = await req("GET", SET, { cookie: platformAdminCk });
  check(
    "settings read without the CSRF-preflight header is rejected (400)",
    setNoHeader.status === 400,
    `status ${setNoHeader.status}`,
  );

  const setGetAdmin = await req("GET", SET, { cookie: platformAdminCk, headers: HDR });
  check(
    "platform admin reads settings (200, registry default + mirror present)",
    setGetAdmin.status === 200 &&
      settingVal(setGetAdmin.body, "general.platformName") === "Agora" &&
      setGetAdmin.body?.mirror?.security?.twoFactorRequired === false &&
      Array.isArray(setGetAdmin.body?.mirror?.authProviders),
    `status ${setGetAdmin.status} ${JSON.stringify(setGetAdmin.body?.mirror)}`,
  );
  check(
    "an unset key reports isOverridden false",
    (setGetAdmin.body?.settings ?? []).find(
      (s: any) => s.key === "general.platformName",
    )?.isOverridden === false,
    JSON.stringify(settingVal(setGetAdmin.body, "general.platformName")),
  );

  // Role gate: viewer can read, cannot write.
  const setGetViewer = await req("GET", SET, { cookie: platformViewerCk, headers: HDR });
  check("platform viewer reads settings (200)", setGetViewer.status === 200, `status ${setGetViewer.status}`);
  const setViewerWrite = await req("PATCH", SET, {
    cookie: platformViewerCk,
    headers: HDR,
    json: { "general.platformName": "Nope" },
  });
  check(
    "platform viewer cannot change settings (403)",
    setViewerWrite.status === 403,
    `status ${setViewerWrite.status}`,
  );

  // Isolation: tenant authority grants no platform authority.
  const setAsOwner = await req("GET", SET, { cookie: ownerCk, headers: HDR });
  check("tenant owner cannot read platform settings (403)", setAsOwner.status === 403, `status ${setAsOwner.status}`);
  const setAsTenantStaff = await req("GET", SET, { cookie: staffCk, slug: "acme", headers: HDR });
  check(
    "tenant staff cannot read platform settings (403)",
    setAsTenantStaff.status === 403,
    `status ${setAsTenantStaff.status}`,
  );

  const setPatchNoHeader = await req("PATCH", SET, {
    cookie: platformAdminCk,
    json: { "general.platformName": "Acme Platform" },
  });
  check(
    "settings write without the CSRF-preflight header is rejected (400)",
    setPatchNoHeader.status === 400,
    `status ${setPatchNoHeader.status}`,
  );

  // Happy path: admin edits a General setting; it persists on reload.
  const setPatch = await req("PATCH", SET, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { "general.platformName": "Acme Platform" },
  });
  check(
    "platform admin updates a General setting (200, value applied)",
    setPatch.status === 200 && settingVal(setPatch.body, "general.platformName") === "Acme Platform",
    `status ${setPatch.status} ${JSON.stringify(settingVal(setPatch.body, "general.platformName"))}`,
  );
  const setReGet = await req("GET", SET, { cookie: platformAdminCk, headers: HDR });
  check(
    "the edited setting persists on reload with isOverridden true",
    settingVal(setReGet.body, "general.platformName") === "Acme Platform" &&
      (setReGet.body?.settings ?? []).find(
        (s: any) => s.key === "general.platformName",
      )?.isOverridden === true,
    JSON.stringify(settingVal(setReGet.body, "general.platformName")),
  );

  // Strict + type validation: unknown/secret keys and wrong types are refused.
  const setUnknownKey = await req("PATCH", SET, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { "email.smtpPassword": "hunter2" },
  });
  check(
    "an unknown/secret key is refused (400, .strict())",
    setUnknownKey.status === 400,
    `status ${setUnknownKey.status}`,
  );
  const setWrongType = await req("PATCH", SET, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { "general.platformName": 123 },
  });
  check(
    "a wrong-typed value is refused (400)",
    setWrongType.status === 400,
    `status ${setWrongType.status}`,
  );

  // Critical-key change writes a platform_audit_event row.
  const setMaintenanceOn = await req("PATCH", SET, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { "maintenance.mode": true },
  });
  check(
    "toggling a critical setting (maintenance.mode) succeeds (200)",
    setMaintenanceOn.status === 200 && settingVal(setMaintenanceOn.body, "maintenance.mode") === true,
    `status ${setMaintenanceOn.status} ${JSON.stringify(settingVal(setMaintenanceOn.body, "maintenance.mode"))}`,
  );
  const [settingAuditRow] = await adminDb
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.platformAuditEvent)
    .where(eq(schema.platformAuditEvent.action, "platform.setting.changed"));
  check(
    "a critical-key change landed in the platform audit log",
    (settingAuditRow?.total ?? 0) >= 1,
    JSON.stringify(settingAuditRow),
  );

  // ── W2s-enforce. Maintenance / read-only / disable-registrations take
  //     effect at the API boundary (Phase 3), and never lock admins out. ──
  // maintenance.mode is ON from the audit test above.
  const maintTenantRead = await req("GET", "/rpc/me", { slug: "acme", cookie: ownerCk });
  check(
    "maintenance mode blocks tenant traffic (503)",
    maintTenantRead.status === 503,
    `status ${maintTenantRead.status} ${JSON.stringify(maintTenantRead.body)}`,
  );
  const maintAdminMe = await req("GET", "/rpc-admin/me", { cookie: platformAdminCk });
  check(
    "the /rpc-admin surface stays reachable under maintenance (200)",
    maintAdminMe.status === 200 && maintAdminMe.body?.platformRole === "admin",
    `status ${maintAdminMe.status}`,
  );
  const maintAdminSettings = await req("GET", SET, { cookie: platformAdminCk, headers: HDR });
  check(
    "admins can still read settings under maintenance to turn it back off (200)",
    maintAdminSettings.status === 200,
    `status ${maintAdminSettings.status}`,
  );

  // Switch maintenance OFF, read-only ON.
  await req("PATCH", SET, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { "maintenance.mode": false, "danger.readOnlyMode": true },
  });
  const roRead = await req("GET", "/rpc/me", { slug: "acme", cookie: ownerCk });
  check(
    "read-only mode still allows tenant reads (200)",
    roRead.status === 200,
    `status ${roRead.status}`,
  );
  const roWrite = await req("POST", "/rpc/projects", {
    slug: "acme",
    cookie: ownerCk,
    json: { name: "should-be-blocked" },
  });
  check(
    "read-only mode blocks a tenant write (423)",
    roWrite.status === 423,
    `status ${roWrite.status} ${JSON.stringify(roWrite.body)}`,
  );

  // Switch read-only OFF, disable-registrations ON.
  await req("PATCH", SET, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { "danger.readOnlyMode": false, "danger.disableRegistrations": true },
  });
  const blockedSignup = await req("POST", "/api/auth/sign-up/email", {
    json: { email: "blocked-signup@e2e.test", password: "Password123!", name: "Blocked" },
  });
  check(
    "disable-registrations blocks a new sign-up (403)",
    blockedSignup.status === 403,
    `status ${blockedSignup.status} ${JSON.stringify(blockedSignup.body)}`,
  );

  // Revert every Danger-Zone/Maintenance flag; confirm normal service resumes.
  await req("PATCH", SET, {
    cookie: platformAdminCk,
    headers: HDR,
    json: {
      "maintenance.mode": false,
      "danger.readOnlyMode": false,
      "danger.disableRegistrations": false,
    },
  });
  const svcRestored = await req("GET", "/rpc/me", { slug: "acme", cookie: ownerCk });
  check(
    "clearing the flags restores normal tenant service (200)",
    svcRestored.status === 200,
    `status ${svcRestored.status}`,
  );
  const allowedSignup = await req("POST", "/api/auth/sign-up/email", {
    json: { email: "allowed-signup@e2e.test", password: "Password123!", name: "Allowed" },
  });
  check(
    "sign-up works again once registrations are re-enabled (not 403)",
    allowedSignup.status !== 403,
    `status ${allowedSignup.status}`,
  );

  // ── W2b. Platform-wide security policy (twoFactorRequired,
  //     sessionMaxAgeMinutes) — .ai/plans/agora/archive/platform-security-policy. ──
  const SP = "/rpc-admin/security-policy";

  const spNoHeader = await req("PATCH", SP, {
    cookie: platformAdminCk,
    json: { sessionMaxAgeMinutes: 60 },
  });
  check(
    "security-policy write without the CSRF-preflight header is rejected (400)",
    spNoHeader.status === 400,
    `status ${spNoHeader.status}`,
  );

  const spGetDefault = await req("GET", SP, { cookie: platformAdminCk, headers: HDR });
  check(
    "GET security-policy returns defaults (200, twoFactorRequired false)",
    spGetDefault.status === 200 && spGetDefault.body?.twoFactorRequired === false,
    `status ${spGetDefault.status} ${JSON.stringify(spGetDefault.body)}`,
  );

  // Role gate: viewer can read, not write.
  const spGetViewer = await req("GET", SP, { cookie: platformViewerCk, headers: HDR });
  check("platform viewer reads security policy (200)", spGetViewer.status === 200, `status ${spGetViewer.status}`);
  const spPatchViewer = await req("PATCH", SP, {
    cookie: platformViewerCk,
    headers: HDR,
    json: { sessionMaxAgeMinutes: 60 },
  });
  check(
    "platform viewer cannot change the security policy (403)",
    spPatchViewer.status === 403,
    `status ${spPatchViewer.status}`,
  );

  // Contract floor (Blocker 2b): a pathological value never reaches the
  // handler's guard logic — it is a Zod 400 before any DB work.
  const spFloorReject = await req("PATCH", SP, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { sessionMaxAgeMinutes: 1 },
  });
  check(
    "sessionMaxAgeMinutes: 1 is rejected by the contract floor (400)",
    spFloorReject.status === 400,
    `status ${spFloorReject.status} ${JSON.stringify(spFloorReject.body)}`,
  );

  // Acting-admin session-age guard: platformAdminCk's own session is brand
  // new (seconds old), so any value below its current age (essentially none
  // at this point) is not realistically triggerable without sleeping — this
  // is covered instead as a unit-level assertion in
  // packages/agora/src/auth/platform-admin.ts's fold-in logic and manually
  // in Phase 4's curl verification. Here we assert the happy path: a
  // generous ceiling is accepted.
  const spSetSessionAge = await req("PATCH", SP, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { sessionMaxAgeMinutes: 480 },
  });
  check(
    "admin sets sessionMaxAgeMinutes within bounds (200)",
    spSetSessionAge.status === 200 && spSetSessionAge.body?.sessionMaxAgeMinutes === 480,
    `status ${spSetSessionAge.status} ${JSON.stringify(spSetSessionAge.body)}`,
  );

  // All-admins 2FA guard (Blocker 3): a second seeded platform-role account
  // with platformRole set but its credential account removed (simulating a
  // social-only admin) blocks the write; the response names its email.
  const secondAdminUser = await ensureStaff("platform-admin-2@e2e.test", "Platform Admin Two");
  // Grab the session cookie BEFORE deleting the credential row below — Better
  // Auth signs in with the password credential, which must still exist at
  // sign-in time; the session itself is fine to keep using afterward.
  const secondAdminCk = await staffCookie("platform-admin-2@e2e.test");
  await adminDb
    .update(schema.user)
    .set({ platformRole: "admin", role: "impersonator" })
    .where(eq(schema.user.id, secondAdminUser));
  await adminDb
    .delete(schema.account)
    .where(and(eq(schema.account.userId, secondAdminUser), eq(schema.account.providerId, "credential")));

  const spEnable2faBlocked = await req("PATCH", SP, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { twoFactorRequired: true },
  });
  check(
    "enabling twoFactorRequired is refused while a second admin is neither enrolled nor enrollable (400)",
    spEnable2faBlocked.status === 400 &&
      typeof spEnable2faBlocked.body?.error === "string" &&
      spEnable2faBlocked.body.error.includes("platform-admin-2@e2e.test"),
    `status ${spEnable2faBlocked.status} ${JSON.stringify(spEnable2faBlocked.body)}`,
  );

  // Enrolling that second admin (marking twoFactorEnabled directly — the
  // real TOTP round trip is already proven above in section W) clears the
  // guard.
  await adminDb
    .update(schema.user)
    .set({ twoFactorEnabled: true })
    .where(eq(schema.user.id, secondAdminUser));
  const spEnable2faOk = await req("PATCH", SP, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { twoFactorRequired: true },
  });
  check(
    "enabling twoFactorRequired succeeds once the second admin is enrolled (200)",
    spEnable2faOk.status === 200 && spEnable2faOk.body?.twoFactorRequired === true,
    `status ${spEnable2faOk.status} ${JSON.stringify(spEnable2faOk.body)}`,
  );

  // Enforcement: the second admin's cookie is now gated — a non-allowlisted
  // route 403s with platform_2fa_required (they are enrolled per the row
  // above, so re-check by un-enrolling to actually exercise the gate).
  await adminDb
    .update(schema.user)
    .set({ twoFactorEnabled: false })
    .where(eq(schema.user.id, secondAdminUser));
  const secondAdminOrgsBlocked = await req("GET", "/rpc-admin/organizations", {
    cookie: secondAdminCk,
  });
  check(
    "a non-enrolled admin is blocked from a non-allowlisted route (403 platform_2fa_required)",
    secondAdminOrgsBlocked.status === 403 &&
      secondAdminOrgsBlocked.body?.error === "platform_2fa_required",
    `status ${secondAdminOrgsBlocked.status} ${JSON.stringify(secondAdminOrgsBlocked.body)}`,
  );
  // Prove the enforcement isn't scoped to platform-admin/routes.ts alone.
  const secondAdminMetricsBlocked = await req("GET", "/rpc-admin/metrics/overview", {
    cookie: secondAdminCk,
  });
  check(
    "rpc-admin-metrics routes also enforce the gate (403 platform_2fa_required)",
    secondAdminMetricsBlocked.status === 403 &&
      secondAdminMetricsBlocked.body?.error === "platform_2fa_required",
    `status ${secondAdminMetricsBlocked.status} ${JSON.stringify(secondAdminMetricsBlocked.body)}`,
  );

  // Allowlist: /me, GET+PATCH /security-policy, and impersonation/stop all
  // stay reachable for the blocked admin.
  const secondAdminMe = await req("GET", "/rpc-admin/me", { cookie: secondAdminCk });
  check(
    "blocked admin's /me still returns a real, non-null platformRole (Condition 4)",
    secondAdminMe.status === 200 && secondAdminMe.body?.platformRole === "admin",
    `status ${secondAdminMe.status} ${JSON.stringify(secondAdminMe.body)}`,
  );
  const secondAdminGetPolicy = await req("GET", SP, { cookie: secondAdminCk, headers: HDR });
  check(
    "blocked admin can still read the security policy (allowlisted)",
    secondAdminGetPolicy.status === 200,
    `status ${secondAdminGetPolicy.status}`,
  );
  const secondAdminStopImpersonation = await req("POST", "/rpc-admin/impersonation/stop", {
    cookie: secondAdminCk,
    headers: HDR,
  });
  check(
    "blocked admin's impersonation/stop stays reachable (not 403 platform_2fa_required)",
    secondAdminStopImpersonation.body?.error !== "platform_2fa_required",
    `status ${secondAdminStopImpersonation.status} ${JSON.stringify(secondAdminStopImpersonation.body)}`,
  );

  // Turn twoFactorRequired back off so it does not leak into later sections
  // (the first platform admin, platformAdminCk, is itself not enrolled).
  const spDisable2fa = await req("PATCH", SP, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { twoFactorRequired: false },
  });
  check(
    "disabling twoFactorRequired succeeds and un-gates later sections (200)",
    spDisable2fa.status === 200 && spDisable2fa.body?.twoFactorRequired === false,
    `status ${spDisable2fa.status} ${JSON.stringify(spDisable2fa.body)}`,
  );
  const spResetSessionAge = await req("PATCH", SP, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { sessionMaxAgeMinutes: null },
  });
  check(
    "clearing sessionMaxAgeMinutes round-trips to null",
    spResetSessionAge.status === 200 && spResetSessionAge.body?.sessionMaxAgeMinutes === null,
    `status ${spResetSessionAge.status} ${JSON.stringify(spResetSessionAge.body)}`,
  );

  // GET /rpc-admin/security/mfa: the acting admin's own status.
  const mfaStatusAdmin = await req("GET", "/rpc-admin/security/mfa", {
    cookie: platformAdminCk,
    headers: HDR,
  });
  check(
    "GET /rpc-admin/security/mfa reports the acting admin's own status",
    mfaStatusAdmin.status === 200 && typeof mfaStatusAdmin.body?.enrolled === "boolean",
    `status ${mfaStatusAdmin.status} ${JSON.stringify(mfaStatusAdmin.body)}`,
  );

  // Break-glass: PLATFORM_SECURITY_ENFORCEMENT_DISABLED short-circuits all
  // enforcement without attempting the DB read. Re-enable twoFactorRequired
  // (second admin is currently un-enrolled again from the block above) so
  // there is something real to bypass, then flip the break-glass var.
  await adminDb
    .update(schema.user)
    .set({ twoFactorEnabled: true })
    .where(eq(schema.user.id, secondAdminUser));
  const spReenable2fa = await req("PATCH", SP, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { twoFactorRequired: true },
  });
  check(
    "re-enabling twoFactorRequired for the break-glass check succeeds (200)",
    spReenable2fa.status === 200,
    `status ${spReenable2fa.status}`,
  );
  await adminDb
    .update(schema.user)
    .set({ twoFactorEnabled: false })
    .where(eq(schema.user.id, secondAdminUser));
  const secondAdminBlockedBeforeBreakGlass = await req("GET", "/rpc-admin/organizations", {
    cookie: secondAdminCk,
  });
  check(
    "sanity: second admin is blocked before break-glass is set",
    secondAdminBlockedBeforeBreakGlass.status === 403,
    `status ${secondAdminBlockedBeforeBreakGlass.status}`,
  );
  process.env.PLATFORM_SECURITY_ENFORCEMENT_DISABLED = "true";
  const secondAdminDuringBreakGlass = await req("GET", "/rpc-admin/organizations", {
    cookie: secondAdminCk,
  });
  check(
    "PLATFORM_SECURITY_ENFORCEMENT_DISABLED short-circuits enforcement (200, not 403)",
    secondAdminDuringBreakGlass.status === 200,
    `status ${secondAdminDuringBreakGlass.status} ${JSON.stringify(secondAdminDuringBreakGlass.body)}`,
  );
  delete process.env.PLATFORM_SECURITY_ENFORCEMENT_DISABLED;
  const secondAdminAfterBreakGlass = await req("GET", "/rpc-admin/organizations", {
    cookie: secondAdminCk,
  });
  check(
    "enforcement resumes once the break-glass var is unset again (403)",
    secondAdminAfterBreakGlass.status === 403,
    `status ${secondAdminAfterBreakGlass.status}`,
  );
  const spDisable2faAfterBreakGlass = await req("PATCH", SP, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { twoFactorRequired: false },
  });
  check(
    "twoFactorRequired disabled again after the break-glass check (200)",
    spDisable2faAfterBreakGlass.status === 200 &&
      spDisable2faAfterBreakGlass.body?.twoFactorRequired === false,
    `status ${spDisable2faAfterBreakGlass.status}`,
  );

  // Demote the second admin back to no platform role at all — it was seeded
  // only to exercise the all-admins 2FA guard and the enforcement gate above,
  // and must not pollute the W0 "last remaining admin" guard tests below,
  // which count real platform-role holders.
  await adminDb
    .update(schema.user)
    .set({ platformRole: null, twoFactorEnabled: false })
    .where(eq(schema.user.id, secondAdminUser));

  // ── W0. Platform staff management (Phase 2): read gate + role-change gate
  //     + a REAL happy-path role change (this also seeds the audit row that
  //     the transactional-audit check below asserts on). ──
  const staffListAsOrdinary = await req("GET", "/rpc-admin/staff", { cookie: ownerCk });
  check(
    "tenant owner with no platform role is blocked from the staff list (403)",
    staffListAsOrdinary.status === 403,
    `status ${staffListAsOrdinary.status}`,
  );

  const staffListAsAdmin = await req("GET", "/rpc-admin/staff", { cookie: platformAdminCk });
  check(
    "platform admin lists platform staff (200)",
    staffListAsAdmin.status === 200 &&
      (staffListAsAdmin.body?.items ?? []).some((s: any) => s.userId === platformAdminUser),
    JSON.stringify(staffListAsAdmin.body),
  );

  const staffListAsViewer = await req("GET", "/rpc-admin/staff", { cookie: platformViewerCk });
  check(
    "platform viewer may also list staff (read-only permission)",
    staffListAsViewer.status === 200,
    `status ${staffListAsViewer.status}`,
  );

  // Create a throwaway platform-role-less staff account to promote, so the
  // owner@/admin@/viewer@ fixtures above stay untouched for later checks.
  const platformExtraUser = await ensureStaff("platform-extra@e2e.test", "Platform Extra");
  const roleChangeAsViewer = await req(
    "PATCH",
    `/rpc-admin/staff/${platformExtraUser}/role`,
    {
      cookie: platformViewerCk,
      headers: HDR,
      json: { role: "viewer" },
    },
  );
  check(
    "platform viewer cannot change a staff role — read does not imply manage (403)",
    roleChangeAsViewer.status === 403,
    `status ${roleChangeAsViewer.status}`,
  );

  const roleChangeHappyPath = await req(
    "PATCH",
    `/rpc-admin/staff/${platformExtraUser}/role`,
    {
      cookie: platformAdminCk,
      headers: HDR,
      json: { role: "viewer" },
    },
  );
  check(
    "platform admin grants a viewer role to a new staff account (200)",
    roleChangeHappyPath.status === 200 && roleChangeHappyPath.body?.platformRole === "viewer",
    `status ${roleChangeHappyPath.status} ${JSON.stringify(roleChangeHappyPath.body)}`,
  );

  // ── W0a0. Platform custom roles (platform-custom-roles P3): CRUD + the three
  //     guards. Read mirrors the staff-list gate (viewer allowed); create/
  //     update/delete need staff:manage; a key colliding with a system role is
  //     refused; a role cannot be deleted while assigned; assigning an unknown
  //     custom key 404s. End state leaves platformExtraUser as it started. ──
  const customRolesAsOwner = await req("GET", "/rpc-admin/staff/roles", { cookie: ownerCk });
  check(
    "tenant owner (no platform role) blocked from the custom-role list (403)",
    customRolesAsOwner.status === 403,
    `status ${customRolesAsOwner.status}`,
  );
  const customRolesAsViewer = await req("GET", "/rpc-admin/staff/roles", {
    cookie: platformViewerCk,
  });
  check(
    "platform viewer may list custom roles (staff:read)",
    customRolesAsViewer.status === 200,
    `status ${customRolesAsViewer.status}`,
  );
  const createRoleAsViewer = await req("POST", "/rpc-admin/staff/roles", {
    cookie: platformViewerCk,
    headers: HDR,
    json: { key: "support-billing", name: "Support Billing", permission: { billing: ["read"] } },
  });
  check(
    "platform viewer cannot create a custom role — read does not imply manage (403)",
    createRoleAsViewer.status === 403,
    `status ${createRoleAsViewer.status}`,
  );
  const createRoleHappy = await req("POST", "/rpc-admin/staff/roles", {
    cookie: platformAdminCk,
    headers: HDR,
    json: {
      key: "support-billing",
      name: "Support Billing",
      description: "read billing only",
      permission: { billing: ["read"] },
    },
  });
  check(
    "platform admin creates a custom role (200, permission sanitized to the vocabulary)",
    createRoleHappy.status === 200 &&
      JSON.stringify(createRoleHappy.body?.permission) === JSON.stringify({ billing: ["read"] }),
    `status ${createRoleHappy.status} ${JSON.stringify(createRoleHappy.body)}`,
  );
  const createRoleCollision = await req("POST", "/rpc-admin/staff/roles", {
    cookie: platformAdminCk,
    headers: HDR,
    json: { key: "admin", name: "Not Allowed", permission: {} },
  });
  check(
    "a custom-role key colliding with a system role is refused (409)",
    createRoleCollision.status === 409,
    `status ${createRoleCollision.status}`,
  );
  const assignCustomRole = await req(
    "PATCH",
    `/rpc-admin/staff/${platformExtraUser}/role`,
    { cookie: platformAdminCk, headers: HDR, json: { role: "support-billing" } },
  );
  check(
    "platform admin assigns a custom role to a staff account (200)",
    assignCustomRole.status === 200 && assignCustomRole.body?.platformRole === "support-billing",
    `status ${assignCustomRole.status} ${JSON.stringify(assignCustomRole.body)}`,
  );
  const deleteAssignedRole = await req("DELETE", "/rpc-admin/staff/roles/support-billing", {
    cookie: platformAdminCk,
    headers: HDR,
  });
  check(
    "a custom role cannot be deleted while it is assigned (409)",
    deleteAssignedRole.status === 409,
    `status ${deleteAssignedRole.status}`,
  );
  const assignUnknownRole = await req(
    "PATCH",
    `/rpc-admin/staff/${platformExtraUser}/role`,
    { cookie: platformAdminCk, headers: HDR, json: { role: "no-such-custom-role" } },
  );
  check(
    "assigning a nonexistent custom-role key is refused (404)",
    assignUnknownRole.status === 404,
    `status ${assignUnknownRole.status}`,
  );
  // Unassign (back to viewer, as it was), then the delete succeeds.
  await req("PATCH", `/rpc-admin/staff/${platformExtraUser}/role`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { role: "viewer" },
  });
  const deleteUnassignedRole = await req("DELETE", "/rpc-admin/staff/roles/support-billing", {
    cookie: platformAdminCk,
    headers: HDR,
  });
  check(
    "an unassigned custom role can be deleted (200)",
    deleteUnassignedRole.status === 200,
    `status ${deleteUnassignedRole.status}`,
  );

  // ── W0a1. Roles & permissions matrix (read-only): gated staff:read, so a
  //     tenant owner with no platform role is blocked, but every platform role
  //     (viewer/support/admin) can view it. The one real mutation stays at
  //     /staff — this route never mutates. ──
  const rolesAsOrdinary = await req("GET", "/rpc-admin/roles", { cookie: ownerCk });
  check(
    "tenant owner with no platform role is blocked from the roles matrix (403)",
    rolesAsOrdinary.status === 403,
    `status ${rolesAsOrdinary.status}`,
  );

  const rolesAsAdmin = await req("GET", "/rpc-admin/roles", { cookie: platformAdminCk });
  const rolesAdminBody = rolesAsAdmin.body;
  check(
    "platform admin loads the roles matrix (200) with statements + all three roles",
    rolesAsAdmin.status === 200 &&
      typeof rolesAdminBody?.statements?.staff !== "undefined" &&
      Array.isArray(rolesAdminBody?.roles) &&
      rolesAdminBody.roles.length === 3 &&
      rolesAdminBody.roles.map((r: any) => r.key).sort().join(",") ===
        "admin,support,viewer",
    JSON.stringify(rolesAsAdmin.body)?.slice(0, 300),
  );
  check(
    "roles matrix reflects the code grants — viewer resolves to read-only staff",
    JSON.stringify(
      rolesAdminBody?.roles?.find((r: any) => r.key === "viewer")?.grants?.staff,
    ) === JSON.stringify(["read"]) &&
      JSON.stringify(
        rolesAdminBody?.roles?.find((r: any) => r.key === "admin")?.grants?.staff,
      ) === JSON.stringify(["read", "manage"]),
    JSON.stringify(rolesAdminBody?.roles?.map((r: any) => ({ k: r.key, staff: r.grants?.staff }))),
  );
  check(
    "roles matrix marks Billing Administrator aspirational and Dashboard as no-resource",
    Array.isArray(rolesAdminBody?.aspirationalRoles) &&
      rolesAdminBody.aspirationalRoles.some((r: any) => r.label === "Billing Administrator") &&
      rolesAdminBody?.groups?.some(
        (g: any) => g.group === "Dashboard" && g.real === false && g.resource === null,
      ),
    JSON.stringify(rolesAdminBody?.aspirationalRoles),
  );
  check(
    "roles matrix assignedCounts reports at least one admin (the platform admin fixture)",
    typeof rolesAdminBody?.assignedCounts?.admin === "number" &&
      rolesAdminBody.assignedCounts.admin >= 1,
    JSON.stringify(rolesAdminBody?.assignedCounts),
  );

  const rolesAsViewer = await req("GET", "/rpc-admin/roles", { cookie: platformViewerCk });
  check(
    "platform viewer may also view the read-only roles matrix (200)",
    rolesAsViewer.status === 200 && Array.isArray(rolesAsViewer.body?.roles),
    `status ${rolesAsViewer.status}`,
  );

  // ── W0a2. Usage & limits (platform-usage-limits Phase 2): derived usage
  //     dashboard/table/detail, gated on usage:read. Happy path + role gate +
  //     cross-tenant no-leak (each tenant's row shows ITS OWN project count). ──
  {
    // Distinguishing fixture: give acme two MORE projects (it already has one
    // seeded) so acme's project count (3) differs from contoso's (1). A vacuous
    // "counts never swap" check would pass even if the route leaked; distinct
    // counts make a leak observable.
    await withTenant(acmeId, (tx) =>
      tx.insert(project).values([
        { id: createId(), tenantId: acmeId, name: "Acme Usage P2" },
        { id: createId(), tenantId: acmeId, name: "Acme Usage P3" },
      ]),
    );

    // Role gate: a tenant owner holding no platform role is refused.
    const usageAsOrdinary = await req("GET", "/rpc-admin/usage/tenants", { cookie: ownerCk });
    check(
      "usage: tenant owner with no platform role is blocked (403)",
      usageAsOrdinary.status === 403,
      `status ${usageAsOrdinary.status}`,
    );

    // Read floor: a platform viewer holds usage:read.
    const overviewAsViewer = await req("GET", "/rpc-admin/usage/overview", { cookie: platformViewerCk });
    check(
      "usage: platform viewer reads the overview (200)",
      overviewAsViewer.status === 200 &&
        typeof overviewAsViewer.body?.totalTenants === "number" &&
        overviewAsViewer.body.totalTenants >= 2 &&
        Array.isArray(overviewAsViewer.body?.byPlan),
      `status ${overviewAsViewer.status} ${JSON.stringify(overviewAsViewer.body)}`,
    );

    // Happy path + isolation: the per-tenant table shows each tenant's OWN
    // project count. Large pageSize so both tenants land on one page.
    const tenants = await req("GET", "/rpc-admin/usage/tenants?pageSize=100", {
      cookie: platformAdminCk,
    });
    const rows: any[] = tenants.body?.items ?? [];
    const acmeRow = rows.find((r) => r.tenantId === acmeId);
    const contosoRow = rows.find((r) => r.tenantId === contosoId);
    const acmeProjects = acmeRow?.resources?.find((x: any) => x.resource === "projects");
    const contosoProjects = contosoRow?.resources?.find((x: any) => x.resource === "projects");
    check(
      "usage: admin lists per-tenant usage (200, both tenants present)",
      tenants.status === 200 && !!acmeRow && !!contosoRow,
      `status ${tenants.status} rows ${rows.length}`,
    );
    check(
      "usage: acme's project count is its own (distinct from contoso's), never swapped",
      typeof acmeProjects?.used === "number" &&
        acmeProjects.used >= 3 &&
        acmeProjects.used !== contosoProjects?.used,
      `acme projects ${JSON.stringify(acmeProjects)}`,
    );
    check(
      "usage: contoso's row shows ITS OWN project count (1) — no cross-tenant leak",
      contosoProjects?.used === 1,
      `contoso projects ${JSON.stringify(contosoProjects)}`,
    );

    // A seat cap is always resolved (free plan = 3 here; acme's pro row was
    // canceled by the earlier billing block → effective free).
    const acmeSeats = acmeRow?.resources?.find((x: any) => x.resource === "seats");
    check(
      "usage: acme's seat resource resolves a finite cap and a used count",
      typeof acmeSeats?.limit === "number" && typeof acmeSeats?.used === "number",
      `acme seats ${JSON.stringify(acmeSeats)}`,
    );

    // Per-org detail (under the /rpc-admin/usage mount).
    const acmeDetail = await req("GET", `/rpc-admin/usage/organizations/${acmeId}`, {
      cookie: platformAdminCk,
    });
    check(
      "usage: per-org detail returns effective plan + plan limits + empty grant list",
      acmeDetail.status === 200 &&
        typeof acmeDetail.body?.plan === "string" &&
        typeof acmeDetail.body?.planLimits?.seats === "number" &&
        typeof acmeDetail.body?.planLimits?.projects === "number" &&
        Array.isArray(acmeDetail.body?.quotaGrants) &&
        acmeDetail.body.quotaGrants.length === 0,
      `status ${acmeDetail.status} ${JSON.stringify(acmeDetail.body)}`,
    );
    const detailGate = await req("GET", `/rpc-admin/usage/organizations/${acmeId}`, {
      cookie: ownerCk,
    });
    check(
      "usage: per-org detail refuses a non-platform actor (403)",
      detailGate.status === 403,
      `status ${detailGate.status}`,
    );
    const detail404 = await req("GET", "/rpc-admin/usage/organizations/nonexistent", {
      cookie: platformAdminCk,
    });
    check(
      "usage: per-org detail 404s an unknown org",
      detail404.status === 404,
      `status ${detail404.status}`,
    );

    // CSV export (Phase 4): gated usage:read, one row per resource.
    const exportRes = await fetch(
      `${base}/rpc-admin/usage/organizations/${acmeId}/export`,
      { headers: { cookie: platformAdminCk, "x-platform-admin": "1" } },
    );
    const exportText = await exportRes.text();
    check(
      "usage: CSV export returns a header + a row per resource",
      exportRes.status === 200 &&
        /resource,used,limit,percent,status/.test(exportText) &&
        /(^|\r\n)seats,/.test(exportText) &&
        /(^|\r\n)projects,/.test(exportText),
      `status ${exportRes.status} body ${JSON.stringify(exportText)}`,
    );
    const exportGate = await fetch(
      `${base}/rpc-admin/usage/organizations/${acmeId}/export`,
      { headers: { cookie: ownerCk, "x-platform-admin": "1" } },
    );
    check(
      "usage: CSV export refuses a non-platform actor (403)",
      exportGate.status === 403,
      `status ${exportGate.status}`,
    );

    // ── Quota grants (Phase 5): happy path + role gate + cross-tenant isolation.
    // Baselines: acme + contoso project caps before any grant.
    const acmeBefore = await req("GET", `/rpc-admin/usage/organizations/${acmeId}`, {
      cookie: platformAdminCk,
    });
    const contosoBefore = await req("GET", `/rpc-admin/usage/organizations/${contosoId}`, {
      cookie: platformAdminCk,
    });
    const acmeProjCapBefore = acmeBefore.body?.resources?.find(
      (x: any) => x.resource === "projects",
    )?.limit;
    const contosoProjCapBefore = contosoBefore.body?.resources?.find(
      (x: any) => x.resource === "projects",
    )?.limit;

    // Role gate: a viewer cannot add a grant.
    const grantAsViewer = await req("POST", `/rpc-admin/usage/organizations/${acmeId}/quota`, {
      cookie: platformViewerCk,
      headers: HDR,
      json: { resource: "projects", amount: 5, expiresAt: null, reason: "e2e" },
    });
    check(
      "usage: platform viewer cannot add a quota grant (403)",
      grantAsViewer.status === 403,
      `status ${grantAsViewer.status}`,
    );
    // Missing preflight header → 400.
    const grantNoHeader = await req("POST", `/rpc-admin/usage/organizations/${acmeId}/quota`, {
      cookie: platformAdminCk,
      json: { resource: "projects", amount: 5, expiresAt: null, reason: "e2e" },
    });
    check(
      "usage: quota grant without the admin header is rejected (400)",
      grantNoHeader.status === 400,
      `status ${grantNoHeader.status}`,
    );

    // Happy path: admin adds a permanent +5 projects grant.
    const grantAdd = await req("POST", `/rpc-admin/usage/organizations/${acmeId}/quota`, {
      cookie: platformAdminCk,
      headers: HDR,
      json: { resource: "projects", amount: 5, expiresAt: null, reason: "extra capacity" },
    });
    const grantId = grantAdd.body?.quotaGrants?.[0]?.id;
    check(
      "usage: admin adds a quota grant (200, one active grant returned)",
      grantAdd.status === 200 &&
        Array.isArray(grantAdd.body?.quotaGrants) &&
        grantAdd.body.quotaGrants.length === 1 &&
        grantAdd.body.quotaGrants[0].active === true &&
        typeof grantId === "string",
      `status ${grantAdd.status} ${JSON.stringify(grantAdd.body)}`,
    );

    // Effective project cap rises by the granted amount.
    const acmeAfter = await req("GET", `/rpc-admin/usage/organizations/${acmeId}`, {
      cookie: platformAdminCk,
    });
    const acmeProjCapAfter = acmeAfter.body?.resources?.find(
      (x: any) => x.resource === "projects",
    )?.limit;
    check(
      "usage: the grant raises acme's effective project cap by 5",
      typeof acmeProjCapBefore === "number" && acmeProjCapAfter === acmeProjCapBefore + 5,
      `before ${acmeProjCapBefore} after ${acmeProjCapAfter}`,
    );

    // Cross-tenant isolation: contoso's cap is unchanged by acme's grant.
    const contosoAfter = await req("GET", `/rpc-admin/usage/organizations/${contosoId}`, {
      cookie: platformAdminCk,
    });
    const contosoProjCapAfter = contosoAfter.body?.resources?.find(
      (x: any) => x.resource === "projects",
    )?.limit;
    check(
      "usage: a grant on acme never changes contoso's effective cap (isolation)",
      contosoProjCapAfter === contosoProjCapBefore,
      `contoso before ${contosoProjCapBefore} after ${contosoProjCapAfter}`,
    );

    // Revoke reverts the cap.
    const revokeGate = await req(
      "POST",
      `/rpc-admin/usage/organizations/${acmeId}/quota/${grantId}/revoke`,
      { cookie: platformViewerCk, headers: HDR },
    );
    check(
      "usage: platform viewer cannot revoke a grant (403)",
      revokeGate.status === 403,
      `status ${revokeGate.status}`,
    );
    const revoke = await req(
      "POST",
      `/rpc-admin/usage/organizations/${acmeId}/quota/${grantId}/revoke`,
      { cookie: platformAdminCk, headers: HDR },
    );
    const revokedGrant = revoke.body?.quotaGrants?.find((g: any) => g.id === grantId);
    check(
      "usage: admin revokes the grant (200, grant marked inactive)",
      revoke.status === 200 && revokedGrant?.active === false && !!revokedGrant?.revokedAt,
      `status ${revoke.status} ${JSON.stringify(revoke.body)}`,
    );
    const acmeReverted = await req("GET", `/rpc-admin/usage/organizations/${acmeId}`, {
      cookie: platformAdminCk,
    });
    const acmeProjCapReverted = acmeReverted.body?.resources?.find(
      (x: any) => x.resource === "projects",
    )?.limit;
    check(
      "usage: revoking the grant reverts acme's effective cap",
      acmeProjCapReverted === acmeProjCapBefore,
      `reverted ${acmeProjCapReverted} baseline ${acmeProjCapBefore}`,
    );

    // ── Real metering (Phase 6): with USAGE_METERING_ENABLED, tenant /rpc
    //    calls increment that tenant's api_requests counter; the other tenant's
    //    counter stays untouched (cross-tenant isolation).
    process.env.USAGE_METERING_ENABLED = "true";
    // Drive several acme tenant requests through the real surface.
    for (let i = 0; i < 5; i++) {
      await req("GET", "/rpc/me", { slug: "acme", cookie: ownerCk });
    }
    // The increment is fire-and-forget; flush by polling history (each awaited
    // admin read lets the pending withTenant writes settle on the pool).
    let acmeApiTotal = 0;
    for (let attempt = 0; attempt < 15 && acmeApiTotal === 0; attempt++) {
      const hist = await req("GET", `/rpc-admin/usage/organizations/${acmeId}/history`, {
        cookie: platformAdminCk,
      });
      const pts =
        hist.body?.items?.find((i: any) => i.resource === "api_requests")?.points ?? [];
      acmeApiTotal = pts.reduce((s: number, p: any) => s + p.value, 0);
    }
    check(
      "usage: metering increments acme's api_requests counter on tenant calls",
      acmeApiTotal >= 1,
      `acme api_requests total ${acmeApiTotal}`,
    );

    const contosoHist = await req(
      "GET",
      `/rpc-admin/usage/organizations/${contosoId}/history`,
      { cookie: platformAdminCk },
    );
    const contosoPts =
      contosoHist.body?.items?.find((i: any) => i.resource === "api_requests")?.points ??
      [];
    const contosoApiTotal = contosoPts.reduce((s: number, p: any) => s + p.value, 0);
    check(
      "usage: acme's metered calls never touch contoso's counter (isolation)",
      contosoApiTotal === 0,
      `contoso api_requests total ${contosoApiTotal}`,
    );

    // History gate + the metering flag off again so later sections are unmetered.
    const histGate = await req(
      "GET",
      `/rpc-admin/usage/organizations/${acmeId}/history`,
      { cookie: ownerCk },
    );
    check(
      "usage: history route refuses a non-platform actor (403)",
      histGate.status === 403,
      `status ${histGate.status}`,
    );
    delete process.env.USAGE_METERING_ENABLED;
  }

  // ── W0b. Billing rollup (Phase 4): read gate only (both platform roles hold
  //     billing:read; the gate that matters is "no platform role at all"). ──
  const billingAsOrdinary = await req("GET", "/rpc-admin/billing/summary", { cookie: ownerCk });
  check(
    "tenant owner with no platform role is blocked from the billing rollup (403)",
    billingAsOrdinary.status === 403,
    `status ${billingAsOrdinary.status}`,
  );

  const billingAsViewer = await req("GET", "/rpc-admin/billing/summary", { cookie: platformViewerCk });
  check(
    "platform viewer reads the billing rollup (200, enabled: false in this env)",
    billingAsViewer.status === 200 && billingAsViewer.body?.enabled === false,
    `status ${billingAsViewer.status} ${JSON.stringify(billingAsViewer.body)}`,
  );

  // ── W0c. Per-org Stripe invoice status (admin-billing-management plan):
  //     the four `reason` branches + the success path, gated on
  //     organization:read (not billing:read). ──
  {
    const invoiceStatusUrl = `/rpc-admin/organizations/${acmeId}/billing/invoice-status`;

    // Acme still carries the pro/Stripe subscription row seeded by the Billing
    // block (U) above — clear it so this block starts from a clean slate and
    // controls exactly when a subscription row (and its provider) exists.
    await withTenant(acmeId, (tx) => tx.delete(tenantSubscription));

    const gateAsOrdinary = await req("GET", invoiceStatusUrl, { cookie: ownerCk });
    check(
      "tenant owner with no platform role is blocked from invoice-status (403)",
      gateAsOrdinary.status === 403,
      `status ${gateAsOrdinary.status}`,
    );

    // Branch 1: not_configured — no STRIPE_SECRET_KEY anywhere in this run yet.
    const notConfigured = await req("GET", invoiceStatusUrl, { cookie: platformViewerCk });
    check(
      "invoice-status: not_configured when billing isn't set up",
      notConfigured.status === 200 &&
        notConfigured.body?.enabled === false &&
        notConfigured.body?.reason === "not_configured",
      `status ${notConfigured.status} ${JSON.stringify(notConfigured.body)}`,
    );

    // Branch 2: unsupported_driver — billing enabled, but the active provider is Xendit.
    process.env.XENDIT_SECRET_KEY = "xnd_test_e2e";
    process.env.BILLING_PROVIDER = "xendit";
    const unsupportedDriver = await req("GET", invoiceStatusUrl, { cookie: platformViewerCk });
    check(
      "invoice-status: unsupported_driver when the active provider is Xendit",
      unsupportedDriver.status === 200 &&
        unsupportedDriver.body?.enabled === false &&
        unsupportedDriver.body?.reason === "unsupported_driver",
      `status ${unsupportedDriver.status} ${JSON.stringify(unsupportedDriver.body)}`,
    );
    delete process.env.XENDIT_SECRET_KEY;

    // Switch to Stripe for the remaining branches.
    process.env.STRIPE_SECRET_KEY = "sk_test_e2e";
    process.env.BILLING_PROVIDER = "stripe";

    // Branch 3: no_customer — Stripe is the provider, but acme has no subscription row yet.
    const noCustomer = await req("GET", invoiceStatusUrl, { cookie: platformViewerCk });
    check(
      "invoice-status: no_customer when the org has no Stripe customer",
      noCustomer.status === 200 &&
        noCustomer.body?.enabled === false &&
        noCustomer.body?.reason === "no_customer",
      `status ${noCustomer.status} ${JSON.stringify(noCustomer.body)}`,
    );

    // Give acme a Stripe-backed subscription row for the remaining branches.
    await withTenant(acmeId, (tx) =>
      tx.insert(tenantSubscription).values({
        id: createId(),
        tenantId: acmeId,
        plan: "pro",
        status: "active",
        seats: 20,
        paymentProvider: "stripe",
        stripeCustomerId: "cus_e2e_acme",
      }),
    );

    // Branch: no_customer again, but this time from a Xendit-created row (a
    // stray stripeCustomerId must never trigger a Stripe invoice-list call).
    await withTenant(acmeId, (tx) =>
      tx
        .update(tenantSubscription)
        .set({ paymentProvider: "xendit" })
        .where(eq(tenantSubscription.tenantId, acmeId)),
    );
    const wrongProvider = await req("GET", invoiceStatusUrl, { cookie: platformViewerCk });
    check(
      "invoice-status: no_customer when the row's paymentProvider isn't stripe",
      wrongProvider.status === 200 &&
        wrongProvider.body?.enabled === false &&
        wrongProvider.body?.reason === "no_customer",
      `status ${wrongProvider.status} ${JSON.stringify(wrongProvider.body)}`,
    );
    await withTenant(acmeId, (tx) =>
      tx
        .update(tenantSubscription)
        .set({ paymentProvider: "stripe" })
        .where(eq(tenantSubscription.tenantId, acmeId)),
    );

    // Branch 4: error — the injected provider's listRecentInvoices throws.
    __setBillingProvider({
      async createCheckoutSession() {
        throw new Error("not used in this test");
      },
      async createPortalSession() {
        throw new Error("not used in this test");
      },
      async listRecentInvoices() {
        throw new Error("simulated Stripe outage");
      },
    });
    const errorBranch = await req("GET", invoiceStatusUrl, { cookie: platformViewerCk });
    check(
      "invoice-status: error when the upstream Stripe read throws",
      errorBranch.status === 200 &&
        errorBranch.body?.enabled === false &&
        errorBranch.body?.reason === "error",
      `status ${errorBranch.status} ${JSON.stringify(errorBranch.body)}`,
    );

    // Success path — a stubbed provider returning a real invoice list.
    const pastDueSeconds = Math.floor(Date.now() / 1000) - 60 * 60 * 24;
    __setBillingProvider({
      async createCheckoutSession() {
        throw new Error("not used in this test");
      },
      async createPortalSession() {
        throw new Error("not used in this test");
      },
      async listRecentInvoices() {
        return [
          {
            status: "open",
            hostedInvoiceUrl: "https://invoice.stripe.com/i/acct/e2e",
            created: pastDueSeconds,
            dueDate: pastDueSeconds,
          },
        ];
      },
    });
    const successBranch = await req("GET", invoiceStatusUrl, { cookie: platformViewerCk });
    check(
      "invoice-status: success path reports hasPastDue + lastInvoiceStatus/Url",
      successBranch.status === 200 &&
        successBranch.body?.enabled === true &&
        successBranch.body?.hasPastDue === true &&
        successBranch.body?.lastInvoiceStatus === "open" &&
        successBranch.body?.lastInvoiceUrl === "https://invoice.stripe.com/i/acct/e2e",
      `status ${successBranch.status} ${JSON.stringify(successBranch.body)}`,
    );

    // Cleanup: restore env + provider + acme's subscription row so later
    // blocks (which assume the free-plan default / no billing) aren't affected.
    __setBillingProvider(null);
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.BILLING_PROVIDER;
    await withTenant(acmeId, (tx) => tx.delete(tenantSubscription));
  }

  // ── W0d. Payments / transactions (spec #7): webhook mirror + list + refund. ──
  {
    process.env.STRIPE_SECRET_KEY = "sk_test_e2e";
    process.env.BILLING_PROVIDER = "stripe";

    // Signed Stripe webhook helper — drives the real /billing/webhook route
    // (the mirror's only write path), exactly as Stripe would.
    async function sendStripeEvent(event: unknown): Promise<number> {
      const payload = JSON.stringify(event);
      const sig = signStripePayload(payload, "whsec_e2e_test_secret");
      const res = await fetch(`${base}/billing/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": sig },
        body: payload,
      });
      return res.status;
    }
    const chargeEvent = (
      id: string,
      chargeId: string,
      tenantId: string,
      amount: number,
      extra: Record<string, unknown> = {},
    ) => ({
      id,
      type: "charge.succeeded",
      data: {
        object: {
          id: chargeId,
          customer: "cus_e2e",
          amount,
          amount_refunded: 0,
          currency: "usd",
          status: "succeeded",
          created: Math.floor(Date.now() / 1000),
          payment_method_details: { card: { brand: "visa", last4: "4242" } },
          metadata: { tenantId },
          ...extra,
        },
      },
    });

    // Seed one charge for acme and one for contoso (cross-tenant isolation).
    check(
      "txn: acme charge.succeeded webhook accepted",
      (await sendStripeEvent(chargeEvent("evt_txn_1", "ch_e2e_acme", acmeId, 5000))) === 200,
    );
    check(
      "txn: contoso charge.succeeded webhook accepted",
      (await sendStripeEvent(chargeEvent("evt_txn_2", "ch_e2e_ctso", contosoId, 7000))) === 200,
    );

    // Happy path: the acme charge appears in the cross-tenant list with the
    // right tenant, amount (minor units), method and status.
    const list = await req("GET", "/rpc-admin/transactions?pageSize=100", {
      cookie: platformAdminCk,
    });
    const acmeRow =
      list.body?.enabled === true
        ? (list.body.items as Array<Record<string, unknown>>).find(
            (r) => r.providerObjectId === "ch_e2e_acme",
          )
        : undefined;
    check(
      "txn: seeded acme charge is listed with amount/method/status/tenant",
      list.status === 200 &&
        list.body?.enabled === true &&
        acmeRow !== undefined &&
        acmeRow.tenantId === acmeId &&
        acmeRow.amount === "5000" &&
        acmeRow.method === "card:visa:4242" &&
        acmeRow.status === "succeeded" &&
        acmeRow.refundable === true,
      `status ${list.status} row ${JSON.stringify(acmeRow)}`,
    );
    const acmeTxnId = acmeRow?.id as string;

    // Idempotency: redelivering the same charge webhook does not duplicate.
    await sendStripeEvent(chargeEvent("evt_txn_1", "ch_e2e_acme", acmeId, 5000));
    const dupCount = await withTenant(acmeId, (tx) =>
      tx
        .select()
        .from(paymentTransaction)
        .where(eq(paymentTransaction.providerObjectId, "ch_e2e_acme")),
    );
    check(
      "txn: redelivered charge webhook does not duplicate the row",
      dupCount.length === 1,
      `rows ${dupCount.length}`,
    );

    // Cross-tenant isolation: acme's per-org timeline never shows contoso's txn.
    const acmeTimeline = await req(
      "GET",
      `/rpc-admin/organizations/${acmeId}/transactions?pageSize=100`,
      { cookie: platformAdminCk },
    );
    const acmeTimelineItems =
      acmeTimeline.body?.enabled === true
        ? (acmeTimeline.body.items as Array<Record<string, unknown>>)
        : [];
    check(
      "txn: acme per-org timeline shows only acme rows (isolation)",
      acmeTimeline.status === 200 &&
        acmeTimelineItems.length > 0 &&
        acmeTimelineItems.every((r) => r.tenantId === acmeId) &&
        !acmeTimelineItems.some((r) => r.providerObjectId === "ch_e2e_ctso"),
      `status ${acmeTimeline.status} items ${JSON.stringify(acmeTimelineItems.map((r) => r.providerObjectId))}`,
    );

    // Role gate: a viewer can read the list but cannot refund.
    const viewerList = await req("GET", "/rpc-admin/transactions", {
      cookie: platformViewerCk,
    });
    check(
      "txn: platform viewer can read the transactions list (200)",
      viewerList.status === 200 && viewerList.body?.enabled === true,
      `status ${viewerList.status}`,
    );
    const viewerRefund = await req("POST", `/rpc-admin/transactions/${acmeTxnId}/refund`, {
      cookie: platformViewerCk,
      headers: { "x-platform-admin": "1" },
      json: { reason: "should be blocked" },
    });
    check(
      "txn: platform viewer is blocked from refunding (403)",
      viewerRefund.status === 403,
      `status ${viewerRefund.status}`,
    );

    // Missing CSRF header is rejected before any work.
    const noCsrf = await req("POST", `/rpc-admin/transactions/${acmeTxnId}/refund`, {
      cookie: platformAdminCk,
      json: { reason: "no header" },
    });
    check(
      "txn: refund without the admin CSRF header is rejected (400)",
      noCsrf.status === 400,
      `status ${noCsrf.status}`,
    );

    // Inject a mock provider that records refund calls (so double-refund safety
    // can be proven against the number of REAL provider calls).
    let refundCalls = 0;
    __setBillingProvider({
      async createCheckoutSession() {
        throw new Error("not used");
      },
      async createPortalSession() {
        throw new Error("not used");
      },
      async createRefund() {
        refundCalls++;
        return { refundId: `re_e2e_${refundCalls}`, status: "pending" };
      },
    });

    // Test provider mismatch: change the provider of the row directly to paymongo,
    // while the active provider (env) is stripe.
    await withTenant(acmeId, (tx) =>
      tx
        .update(paymentTransaction)
        .set({ paymentProvider: "paymongo" })
        .where(eq(paymentTransaction.id, acmeTxnId))
    );
    const mismatchRefund = await req("POST", `/rpc-admin/transactions/${acmeTxnId}/refund`, {
      cookie: platformAdminCk,
      headers: { "x-platform-admin": "1" },
      json: { reason: "mismatch test" },
    });
    check(
      "txn: cross-provider refund is rejected (422)",
      mismatchRefund.status === 422,
      `status ${mismatchRefund.status}`,
    );

    // Test invoice-kind row rejection:
    await withTenant(acmeId, (tx) =>
      tx
        .update(paymentTransaction)
        .set({ paymentProvider: "stripe", kind: "invoice" })
        .where(eq(paymentTransaction.id, acmeTxnId))
    );
    const invoiceRefund = await req("POST", `/rpc-admin/transactions/${acmeTxnId}/refund`, {
      cookie: platformAdminCk,
      headers: { "x-platform-admin": "1" },
      json: { reason: "invoice test" },
    });
    check(
      "txn: invoice refund is rejected (422)",
      invoiceRefund.status === 422,
      `status ${invoiceRefund.status}`,
    );

    // Restore to stripe/charge so the rest of the test works.
    await withTenant(acmeId, (tx) =>
      tx
        .update(paymentTransaction)
        .set({ paymentProvider: "stripe", kind: "charge" })
        .where(eq(paymentTransaction.id, acmeTxnId))
    );

    // Full refund by admin: 200 + row moves to refund_pending.
    const fullRefund = await req("POST", `/rpc-admin/transactions/${acmeTxnId}/refund`, {
      cookie: platformAdminCk,
      headers: { "x-platform-admin": "1" },
      json: { reason: "customer request" },
    });
    check(
      "txn: admin issues a full refund (200 → refund_pending)",
      fullRefund.status === 200 &&
        fullRefund.body?.ok === true &&
        fullRefund.body?.status === "refund_pending",
      `status ${fullRefund.status} ${JSON.stringify(fullRefund.body)}`,
    );

    // Now test a paymongo refund pass when provider is paymongo
    process.env.BILLING_PROVIDER = "paymongo";
    process.env.PAYMONGO_SECRET_KEY = "sk_test_123";
    __setBillingProvider({
      async createCheckoutSession() { throw new Error("not used"); },
      async createPortalSession() { throw new Error("not used"); },
      async createRefund(params: any) {
        // Assert the reason is threaded!
        if (params.reason !== "pm test") {
          throw new Error("Reason not passed to provider!");
        }
        refundCalls++;
        return { refundId: `re_pmg_1`, status: "pending" };
      },
    });
    const pmTxnRes = await withTenant(acmeId, (tx) =>
      tx
        .insert(paymentTransaction)
        .values({
          tenantId: acmeId,
          providerObjectId: "ch_pmg_man",
          paymentProvider: "paymongo",
          kind: "charge",
          amount: "2000",
          currency: "usd",
          status: "succeeded",
          occurredAt: new Date(),
        })
        .returning({ id: paymentTransaction.id }),
    );
    const pmTxnId = pmTxnRes[0]?.id as string;
    const pmRefund = await req("POST", `/rpc-admin/transactions/${pmTxnId}/refund`, {
      cookie: platformAdminCk,
      headers: { "x-platform-admin": "1" },
      json: { reason: "pm test" },
    });
    check(
      "txn: paymongo refund passes when provider is paymongo",
      pmRefund.status === 200,
      `status ${pmRefund.status}`,
    );

    // restore back to stripe — must also clear PAYMONGO_SECRET_KEY, not just
    // BILLING_PROVIDER: a later section deletes BILLING_PROVIDER to test provider
    // inference, and a leaked PAYMONGO_SECRET_KEY would make getBillingProviderId()
    // infer "paymongo" there instead of falling through to billing-disabled.
    process.env.BILLING_PROVIDER = "stripe";
    delete process.env.PAYMONGO_SECRET_KEY;
    __setBillingProvider({
      async createCheckoutSession() { throw new Error("not used"); },
      async createPortalSession() { throw new Error("not used"); },
      async createRefund() {
        refundCalls++;
        return { refundId: `re_e2e_${refundCalls}`, status: "pending" };
      },
    });

    // Double-refund safety: a second refund on the same (now refund_pending)
    // txn returns 409 and issues NO second provider call.
    const refundCallsBefore = refundCalls;
    const secondRefund = await req("POST", `/rpc-admin/transactions/${acmeTxnId}/refund`, {
      cookie: platformAdminCk,
      headers: { "x-platform-admin": "1" },
      json: { reason: "double click" },
    });
    check(
      "txn: a second refund on the same charge returns 409",
      secondRefund.status === 409,
      `status ${secondRefund.status}`,
    );
    check(
      "txn: the 409 issued no second provider refund call",
      refundCalls === refundCallsBefore,
      `calls ${refundCalls} vs ${refundCallsBefore}`,
    );

    // The charge.refunded webhook finalizes the row to `refunded`.
    await sendStripeEvent({
      id: "evt_txn_refund_1",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_e2e_acme",
          customer: "cus_e2e",
          amount: 5000,
          amount_refunded: 5000,
          refunded: true,
          currency: "usd",
          metadata: { tenantId: acmeId },
        },
      },
    });
    const [finalized] = await withTenant(acmeId, (tx) =>
      tx
        .select()
        .from(paymentTransaction)
        .where(eq(paymentTransaction.providerObjectId, "ch_e2e_acme")),
    );
    check(
      "txn: charge.refunded webhook finalizes the row to refunded",
      finalized?.status === "refunded" && finalized?.refundedAmount === "5000",
      `${JSON.stringify({ status: finalized?.status, refunded: finalized?.refundedAmount })}`,
    );

    // Partial refund: a fresh charge, a partial refund, then a partial
    // charge.refunded webhook → partially_refunded.
    await sendStripeEvent(chargeEvent("evt_txn_3", "ch_e2e_acme2", acmeId, 8000));
    const list2 = await req("GET", "/rpc-admin/transactions?pageSize=100", {
      cookie: platformAdminCk,
    });
    const partialRow =
      list2.body?.enabled === true
        ? (list2.body.items as Array<Record<string, unknown>>).find(
            (r) => r.providerObjectId === "ch_e2e_acme2",
          )
        : undefined;
    const partialTxnId = partialRow?.id as string;
    const partialRefund = await req(
      "POST",
      `/rpc-admin/transactions/${partialTxnId}/refund`,
      {
        cookie: platformAdminCk,
        headers: { "x-platform-admin": "1" },
        json: { reason: "partial", amount: "3000" },
      },
    );
    check(
      "txn: admin issues a partial refund (200)",
      partialRefund.status === 200 && partialRefund.body?.ok === true,
      `status ${partialRefund.status} ${JSON.stringify(partialRefund.body)}`,
    );
    await sendStripeEvent({
      id: "evt_txn_refund_2",
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_e2e_acme2",
          customer: "cus_e2e",
          amount: 8000,
          amount_refunded: 3000,
          refunded: true,
          currency: "usd",
          metadata: { tenantId: acmeId },
        },
      },
    });
    const [partialFinal] = await withTenant(acmeId, (tx) =>
      tx
        .select()
        .from(paymentTransaction)
        .where(eq(paymentTransaction.providerObjectId, "ch_e2e_acme2")),
    );
    check(
      "txn: partial charge.refunded webhook → partially_refunded",
      partialFinal?.status === "partially_refunded" &&
        partialFinal?.refundedAmount === "3000",
      `${JSON.stringify({ status: partialFinal?.status, refunded: partialFinal?.refundedAmount })}`,
    );

    // Billing disabled: the list degrades to { enabled: false } and refund 409s.
    __setBillingProvider(null);
    process.env.BILLING_ENABLED = "false";
    const disabledList = await req("GET", "/rpc-admin/transactions", {
      cookie: platformAdminCk,
    });
    check(
      "txn: list reports { enabled: false } when billing is off",
      disabledList.status === 200 && disabledList.body?.enabled === false,
      `status ${disabledList.status} ${JSON.stringify(disabledList.body)}`,
    );
    const disabledRefund = await req(
      "POST",
      `/rpc-admin/transactions/${partialTxnId}/refund`,
      {
        cookie: platformAdminCk,
        headers: { "x-platform-admin": "1" },
        json: { reason: "billing off" },
      },
    );
    check(
      "txn: refund is refused (409) when billing is off",
      disabledRefund.status === 409,
      `status ${disabledRefund.status}`,
    );

    // Cleanup: restore env/provider + drop seeded rows so later blocks are clean.
    delete process.env.BILLING_ENABLED;
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.BILLING_PROVIDER;
    await withTenant(acmeId, (tx) => tx.delete(paymentTransaction));
    await withTenant(contosoId, (tx) => tx.delete(paymentTransaction));
  }

  // ── W. Platform-wide audit log (Phase 3): read gate + transactional writes. ──
  const auditAsViewer = await req("GET", "/rpc-admin/audit?pageSize=100", {
    cookie: platformViewerCk,
  });
  check(
    "platform viewer reads the platform audit log (200)",
    auditAsViewer.status === 200,
    `status ${auditAsViewer.status}`,
  );
  const auditAsOrdinary = await req("GET", "/rpc-admin/audit", { cookie: staffCk, slug: "acme" });
  check(
    "tenant staff (no platform role) cannot read the platform audit log (403)",
    auditAsOrdinary.status === 403,
    `status ${auditAsOrdinary.status}`,
  );

  // The suspend/resume/auth-provider/staff-role actions performed above must
  // each have left a durable platform_audit_event row.
  const platformAuditActions = new Set<string>(
    (auditAsViewer.body?.items ?? []).map((r: any) => r.action as string),
  );
  check(
    "suspend/resume dual-write landed in the platform audit log",
    platformAuditActions.has("platform.tenant.suspended") &&
      platformAuditActions.has("platform.tenant.resumed"),
    JSON.stringify([...platformAuditActions]),
  );
  check(
    "auth-provider toggle landed in the platform audit log (transactional)",
    platformAuditActions.has("platform.authProvider.changed"),
    JSON.stringify([...platformAuditActions]),
  );
  check(
    "staff role change landed in the platform audit log (transactional)",
    platformAuditActions.has("platform.staff.roleChanged"),
    JSON.stringify([...platformAuditActions]),
  );

  // ── W-expansion. Audit rows now capture actorRole / userAgent / result /
  //    tenantLabel, and the list filters on actorRole + result. ──
  const AUDIT_UA = "e2e-audit-agent/1.0";

  // Happy path: a fresh audited mutation carrying an explicit user-agent must
  // record actorRole (the acting admin's platform role), that user-agent, and
  // result="success". A no-op edit (same values) avoids changing contoso state.
  const editWithUa = await req("PATCH", `/rpc-admin/organizations/${contosoId}`, {
    cookie: platformAdminCk,
    headers: { ...HDR, "user-agent": AUDIT_UA },
    json: { name: "Contoso Renamed" },
  });
  check("audit-expansion: no-op edit succeeds (200)", editWithUa.status === 200, `status ${editWithUa.status}`);

  const auditRoleSuccess = await req(
    "GET",
    "/rpc-admin/audit?pageSize=100&actorRole=admin&result=success",
    { cookie: platformAdminCk },
  );
  check(
    "audit-expansion: actorRole+result filters return 200",
    auditRoleSuccess.status === 200,
    `status ${auditRoleSuccess.status}`,
  );
  const roleSuccessRows = (auditRoleSuccess.body?.items ?? []) as any[];
  check(
    "audit-expansion: actorRole=admin&result=success filter returns only matching rows",
    roleSuccessRows.length > 0 &&
      roleSuccessRows.every((r) => r.actorRole === "admin" && r.result === "success"),
    JSON.stringify(roleSuccessRows.slice(0, 3)),
  );

  // Look the fresh edit row up by action (not the shared page) so a large audit
  // history can never push it past pageSize.
  const editRowRes = await req("GET", "/rpc-admin/audit?pageSize=20&action=platform.tenant.edited", {
    cookie: platformAdminCk,
  });
  const editRow = ((editRowRes.body?.items ?? []) as any[]).find(
    (r) => r.targetId === contosoId && r.userAgent === AUDIT_UA,
  );
  check(
    "audit-expansion: edit row carries actorRole=admin, result=success, userAgent",
    !!editRow && editRow.actorRole === "admin" && editRow.result === "success" && editRow.userAgent === AUDIT_UA,
    JSON.stringify(editRow),
  );

  // tenantLabel is resolved for an organization-targeted row — the compliance
  // export above wrote one for acme (targetType="organization").
  const exportRowRes = await req(
    "GET",
    "/rpc-admin/audit?pageSize=20&action=tenant.exported_by_platform_admin",
    { cookie: platformAdminCk },
  );
  const exportRow = ((exportRowRes.body?.items ?? []) as any[]).find(
    (r) => r.targetId === acmeId,
  );
  check(
    "audit-expansion: org-targeted row resolves tenantLabel (org name)",
    !!exportRow && typeof exportRow.tenantLabel === "string" && exportRow.tenantLabel.length > 0,
    JSON.stringify(exportRow),
  );

  // result=failure filter isolates failure rows only.
  const auditFailureFilter = await req("GET", "/rpc-admin/audit?pageSize=100&result=failure", {
    cookie: platformAdminCk,
  });
  check(
    "audit-expansion: result=failure filter returns 200 and only failure rows",
    auditFailureFilter.status === 200 &&
      ((auditFailureFilter.body?.items ?? []) as any[]).every((r) => r.result === "failure"),
    `status ${auditFailureFilter.status}`,
  );

  // Failure capture: a DENIED mutating /rpc-admin call (viewer lacks the
  // permission) records a best-effort result="failure" row via the onError
  // hook — fire-and-forget, so poll briefly for it. actorRole resolves to the
  // caller's platform role ("viewer") and the user-agent is captured.
  const deniedMutation = await req("POST", `/rpc-admin/organizations/${contosoId}/suspend`, {
    cookie: platformViewerCk,
    headers: { ...HDR, "user-agent": AUDIT_UA },
  });
  check(
    "audit-expansion: viewer's mutating call is still denied (403)",
    deniedMutation.status === 403,
    `status ${deniedMutation.status}`,
  );
  let failureRow: any = null;
  for (let i = 0; i < 40 && !failureRow; i++) {
    const poll = await req(
      "GET",
      "/rpc-admin/audit?pageSize=100&result=failure&action=platform_admin.request_failed",
      { cookie: platformAdminCk },
    );
    failureRow = ((poll.body?.items ?? []) as any[]).find(
      (r) => r.actorRole === "viewer" && r.userAgent === AUDIT_UA,
    );
    if (!failureRow) await new Promise((res) => setTimeout(res, 25));
  }
  check(
    "audit-expansion: denied mutating call records a result=failure row (actorRole=viewer, userAgent)",
    !!failureRow && failureRow.result === "failure",
    JSON.stringify(failureRow),
  );

  // C1 (active-only last-admin reconciliation): seed a BANNED admin so the
  // last-admin refusal below ALSO proves the guard counts ACTIVE (non-banned)
  // admins only. A banned admin provides no admin access, so it must not mask
  // platformAdminUser as the last usable admin — with the old all-`admin`
  // count the self-demote below would have been ALLOWED (→ platform lockout).
  const bannedAdminUser = await ensureStaff("platform-banned-admin@e2e.test", "Banned Admin");
  await adminDb
    .update(schema.user)
    .set({ platformRole: "admin", role: "impersonator", banned: true })
    .where(eq(schema.user.id, bannedAdminUser));

  // Atomicity: a staff-role-change request that fails the last-admin guard
  // (inside the same adminDb.transaction as the audit insert) must leave NO
  // audit row behind — the mutation and the audit write commit or roll back
  // together.
  const [beforeCountRow] = await adminDb
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.platformAuditEvent)
    .where(eq(schema.platformAuditEvent.action, "platform.staff.roleChanged"));
  const beforeCount = beforeCountRow?.total ?? 0;
  const failedRoleChange = await req(
    "PATCH",
    `/rpc-admin/staff/${platformAdminUser}/role`,
    {
      cookie: platformAdminCk,
      headers: HDR,
      json: { role: "viewer" },
    },
  );
  check(
    "demoting the last platform admin is refused (400)",
    failedRoleChange.status === 400,
    `status ${failedRoleChange.status} ${JSON.stringify(failedRoleChange.body)}`,
  );
  const [afterCountRow] = await adminDb
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(schema.platformAuditEvent)
    .where(eq(schema.platformAuditEvent.action, "platform.staff.roleChanged"));
  const afterCount = afterCountRow?.total ?? 0;
  check(
    "a failed staff-role-change transaction leaves no new audit row",
    afterCount === beforeCount,
    `before ${beforeCount} after ${afterCount}`,
  );
  check(
    "last-admin guard counts ACTIVE admins only — a banned admin does not mask the last active admin (demote still refused)",
    failedRoleChange.status === 400,
    `status ${failedRoleChange.status}`,
  );
  // Restore: the banned admin was a probe for the active-only count only.
  await adminDb
    .update(schema.user)
    .set({ platformRole: null, role: null, banned: false })
    .where(eq(schema.user.id, bannedAdminUser));

  check(
    "platform_audit_event is NOT RLS-scoped (absent from both tenant table sets)",
    !(APP_TENANT_TABLES as readonly string[]).includes("PlatformAuditEvents") &&
      !(BASE_TENANT_TABLES as readonly string[]).includes("PlatformAuditEvents"),
  );

  // ── W0d. Administrator management (platform-administrators-management):
  //     enriched list, invite (grant existing + create new), disable guard,
  //     reset-MFA gate/self/happy. Uses a DEDICATED admin actor so its
  //     mutations don't share the platformAdminCk rate-limit budget already
  //     spent above. Runs AFTER the sole-admin last-admin tests, so adding
  //     admins here is safe. ──
  // NB: 2FA OFF on the sign-in actor — a twoFactorEnabled user gets a
  // two-factor challenge from signInEmail instead of a session cookie.
  // twoFactorRequired is off platform-wide at this point, so a 2FA-off admin
  // is not blocked by the enforcement gate.
  const platformAdminsAdmin = await ensureStaff("platform-admins@e2e.test", "Platform Admins Admin");
  await adminDb
    .update(schema.user)
    .set({ platformRole: "admin", role: "impersonator" })
    .where(eq(schema.user.id, platformAdminsAdmin));
  const platformAdminsAdminCk = await staffCookie("platform-admins@e2e.test");

  const enrichedStaffList = await req("GET", "/rpc-admin/staff", {
    cookie: platformAdminsAdminCk,
  });
  const enrichedSelf = (enrichedStaffList.body?.items ?? []).find(
    (s: any) => s.userId === platformAdminsAdmin,
  );
  check(
    "staff list is enriched with status / mfaEnabled / lastActiveAt / lastActivityAt",
    enrichedStaffList.status === 200 &&
      enrichedSelf &&
      enrichedSelf.status === "active" &&
      enrichedSelf.mfaEnabled === false &&
      "lastActiveAt" in enrichedSelf &&
      "lastActivityAt" in enrichedSelf,
    JSON.stringify(enrichedSelf),
  );

  const inviteAsViewer = await req("POST", "/rpc-admin/staff/invite", {
    cookie: platformViewerCk,
    headers: HDR,
    json: { email: "should-not-exist@e2e.test", name: "Nope", role: "viewer" },
  });
  check(
    "platform viewer cannot invite an administrator — read does not imply manage (403)",
    inviteAsViewer.status === 403,
    `status ${inviteAsViewer.status}`,
  );

  // Grant to an EXISTING account (platform-extra is a viewer from W0) — an
  // idempotent role grant, not a new account.
  const inviteExisting = await req("POST", "/rpc-admin/staff/invite", {
    cookie: platformAdminsAdminCk,
    headers: HDR,
    json: { email: "platform-extra@e2e.test", name: "Platform Extra", role: "support" },
  });
  check(
    "invite grants a role to an existing account (200, existingUser, no new account)",
    inviteExisting.status === 200 &&
      inviteExisting.body?.existingUser === true &&
      inviteExisting.body?.platformRole === "support",
    JSON.stringify(inviteExisting.body),
  );

  // Invite a brand-new email → account created + set-password email sent.
  const inviteNew = await req("POST", "/rpc-admin/staff/invite", {
    cookie: platformAdminsAdminCk,
    headers: HDR,
    json: { email: "platform-invited@e2e.test", name: "Invited Admin", role: "viewer" },
  });
  check(
    "invite creates a new administrator account (200, createdUser)",
    inviteNew.status === 200 && inviteNew.body?.createdUser === true,
    JSON.stringify(inviteNew.body),
  );
  // The created account has a `credential` row — the set-password email (sent
  // via the password-reset flow) targets it, so its presence is what makes the
  // invitee able to set their own password.
  const [invitedCredential] = await adminDb
    .select({ id: schema.account.id })
    .from(schema.account)
    .where(
      and(
        eq(schema.account.userId, String(inviteNew.body?.userId)),
        eq(schema.account.providerId, "credential"),
      ),
    );
  check(
    "the invited administrator has a credential account for the set-password email",
    !!invitedCredential,
    JSON.stringify(inviteNew.body),
  );
  const listAfterInvite = await req("GET", "/rpc-admin/staff", {
    cookie: platformAdminsAdminCk,
  });
  const invitedRow = (listAfterInvite.body?.items ?? []).find(
    (s: any) => s.email === "platform-invited@e2e.test",
  );
  check(
    "the invited administrator appears in the list (viewer, active, MFA off)",
    invitedRow &&
      invitedRow.platformRole === "viewer" &&
      invitedRow.status === "active" &&
      invitedRow.mfaEnabled === false,
    JSON.stringify(invitedRow),
  );

  // Disabling a NON-last admin succeeds (a disposable admin, so ≥1 remains) —
  // exercises the ban route's new advisory-locked last-active-admin guard on
  // the allow path.
  const disposableAdmin = await ensureStaff("platform-disposable-admin@e2e.test", "Disposable Admin");
  await adminDb
    .update(schema.user)
    .set({ platformRole: "admin", role: "impersonator", twoFactorEnabled: true })
    .where(eq(schema.user.id, disposableAdmin));
  const disableNonLast = await req("PATCH", `/rpc-admin/users/${disposableAdmin}/ban`, {
    cookie: platformAdminsAdminCk,
    headers: HDR,
    json: { banReason: "e2e: disable a non-last admin" },
  });
  check(
    "disabling a non-last admin succeeds (200)",
    disableNonLast.status === 200 && disableNonLast.body?.banned === true,
    JSON.stringify(disableNonLast.body),
  );

  // reset-MFA: role gate + self-guard + happy path.
  const resetMfaAsViewer = await req("POST", `/rpc-admin/users/${disposableAdmin}/reset-mfa`, {
    cookie: platformViewerCk,
    headers: HDR,
  });
  check(
    "platform viewer cannot reset an administrator's MFA (403)",
    resetMfaAsViewer.status === 403,
    `status ${resetMfaAsViewer.status}`,
  );
  const resetMfaSelf = await req("POST", `/rpc-admin/users/${platformAdminsAdmin}/reset-mfa`, {
    cookie: platformAdminsAdminCk,
    headers: HDR,
  });
  check(
    "resetting your own MFA is blocked (400)",
    resetMfaSelf.status === 400,
    `status ${resetMfaSelf.status}`,
  );
  const resetMfaHappy = await req("POST", `/rpc-admin/users/${disposableAdmin}/reset-mfa`, {
    cookie: platformAdminsAdminCk,
    headers: HDR,
  });
  check(
    "reset-MFA clears a target administrator's TOTP (200)",
    resetMfaHappy.status === 200 && resetMfaHappy.body?.ok === true,
    JSON.stringify(resetMfaHappy.body),
  );
  const [disposableAfter] = await adminDb
    .select({ tfe: schema.user.twoFactorEnabled })
    .from(schema.user)
    .where(eq(schema.user.id, disposableAdmin));
  check(
    "reset-MFA set twoFactorEnabled=false on the target",
    disposableAfter?.tfe === false,
    JSON.stringify(disposableAfter),
  );

  // Cleanup: demote the disposable + dedicated-actor admins so later blocks see
  // the same admin set they did before this block.
  await adminDb
    .update(schema.user)
    .set({ platformRole: null, role: null, banned: false, banReason: null })
    .where(eq(schema.user.id, disposableAdmin));
  await adminDb
    .update(schema.user)
    .set({ platformRole: null, role: null })
    .where(eq(schema.user.id, platformAdminsAdmin));

  // ── W1. Subscription plan catalog (subscription-plans-catalog): CRUD, the
  //     built-in immutability + active-subscription guards, the plan:read/
  //     plan:manage role gate, and platform-global (no-tenant) isolation. Runs
  //     before the destructive delete block. The e2e harness generates schema
  //     from Drizzle and does NOT run the migration seed backfill, so seed the
  //     built-in rows here first, then give contoso an active `pro`
  //     subscription so the rollup is non-zero and the guard has something to
  //     refuse. ──
  await adminDb.insert(schema.plan).values([
    {
      id: createId(),
      key: "free",
      isBuiltIn: true,
      displayName: "Free",
      planType: "free",
      featureAccess: [],
      monthlyPrice: "0",
      annualPrice: "0",
      status: "active",
      sortOrder: 0,
    },
    {
      id: createId(),
      key: "pro",
      isBuiltIn: true,
      displayName: "Pro",
      planType: "business",
      featureAccess: ["custom_domains"],
      monthlyPrice: "20",
      annualPrice: "200",
      maxUsers: 20,
      status: "active",
      sortOrder: 1,
    },
    {
      id: createId(),
      key: "enterprise",
      isBuiltIn: true,
      displayName: "Enterprise",
      planType: "enterprise",
      featureAccess: ["custom_domains"],
      monthlyPrice: "0",
      annualPrice: "0",
      maxUsers: -1,
      status: "active",
      sortOrder: 2,
    },
  ]);
  await withTenant(contosoId, (tx) =>
    tx.insert(tenantSubscription).values({
      id: createId(),
      tenantId: contosoId,
      plan: "pro",
      status: "active",
      seats: 20,
    }),
  );
  // A dedicated platform admin so this block's ~6 successful mutations don't
  // trip the per-actor mutate rate limiter already spent by the earlier
  // suspend/resume/override/staff-role blocks.
  const platformPlansAdmin = await ensureStaff("platform-plans@e2e.test", "Platform Plans Admin");
  await adminDb
    .update(schema.user)
    .set({ platformRole: "admin", role: "impersonator" })
    .where(eq(schema.user.id, platformPlansAdmin));
  const platformPlansAdminCk = await staffCookie("platform-plans@e2e.test");

  // Read gate — a platform viewer can read the catalog; an ordinary tenant
  // owner with no platform role cannot.
  const plansAsViewer = await req("GET", "/rpc-admin/plans", { cookie: platformViewerCk });
  check(
    "platform viewer reads the plan catalog (200)",
    plansAsViewer.status === 200 && Array.isArray(plansAsViewer.body?.items),
    `status ${plansAsViewer.status}`,
  );
  const proRow = (plansAsViewer.body?.items ?? []).find((p: any) => p.key === "pro");
  check(
    "built-in pro row shows its subscriber count + est. revenue and is flagged built-in",
    proRow?.isBuiltIn === true &&
      proRow?.subscriberCount === 1 &&
      proRow?.activeSubscriptionCount === 1 &&
      proRow?.estMonthlyRevenue === "20.00" &&
      proRow?.estAnnualRevenue === "200.00",
    JSON.stringify(proRow),
  );
  const plansAsOrdinary = await req("GET", "/rpc-admin/plans", { cookie: ownerCk, slug: "acme" });
  check(
    "tenant owner with no platform role is blocked from the plan catalog (403)",
    plansAsOrdinary.status === 403,
    `status ${plansAsOrdinary.status}`,
  );

  // Role gate — a viewer holds plan:read but not plan:manage, so every mutation
  // is refused server-side even with the platform-admin header present.
  const createAsViewer = await req("POST", "/rpc-admin/plans", {
    cookie: platformViewerCk,
    headers: HDR,
    json: { key: "viewer-attempt", displayName: "Nope" },
  });
  check(
    "platform viewer cannot create a plan — read does not imply manage (403)",
    createAsViewer.status === 403,
    `status ${createAsViewer.status}`,
  );

  // Happy path — admin creates a custom plan, edits it, duplicates it, then
  // deactivates and archives it (no subscribers, so both are allowed).
  const createPlan = await req("POST", "/rpc-admin/plans", {
    cookie: platformPlansAdminCk,
    headers: HDR,
    json: {
      key: "startup",
      displayName: "Startup",
      planType: "basic",
      monthlyPrice: "10",
      annualPrice: "100",
      status: "active",
    },
  });
  check(
    "platform admin creates a custom plan (200)",
    createPlan.status === 200 &&
      createPlan.body?.key === "startup" &&
      createPlan.body?.isBuiltIn === false &&
      createPlan.body?.monthlyPrice === "10.00",
    `status ${createPlan.status} ${JSON.stringify(createPlan.body)}`,
  );

  const createDupKey = await req("POST", "/rpc-admin/plans", {
    cookie: platformPlansAdminCk,
    headers: HDR,
    json: { key: "startup", displayName: "Collision" },
  });
  check(
    "creating a plan with a duplicate key is refused (409)",
    createDupKey.status === 409,
    `status ${createDupKey.status}`,
  );

  const editPlan = await req("PATCH", "/rpc-admin/plans/startup", {
    cookie: platformPlansAdminCk,
    headers: HDR,
    json: { monthlyPrice: "12", displayName: "Startup Plus" },
  });
  check(
    "platform admin edits the custom plan (200)",
    editPlan.status === 200 &&
      editPlan.body?.monthlyPrice === "12.00" &&
      editPlan.body?.displayName === "Startup Plus",
    `status ${editPlan.status} ${JSON.stringify(editPlan.body)}`,
  );

  // Multi-currency prices (unified-billing-price-source Phase 1b) — additive:
  // creating WITHOUT `prices` (above) still dual-writes exactly one plan_price
  // row via the legacy scalar fields. Now add a second currency via `prices`.
  const addPricesPlan = await req("PATCH", "/rpc-admin/plans/startup", {
    cookie: platformPlansAdminCk,
    headers: HDR,
    json: {
      prices: [
        { currency: "usd", monthlyPrice: "12.00", annualPrice: "120.00" },
        { currency: "php", monthlyPrice: "680.00", annualPrice: "6800.00" },
      ],
    },
  });
  check(
    "txn: multi-currency PATCH returns both prices rows",
    addPricesPlan.status === 200 &&
      Array.isArray(addPricesPlan.body?.prices) &&
      addPricesPlan.body.prices.length === 2 &&
      addPricesPlan.body.prices.some(
        (p: any) => p.currency === "usd" && p.monthlyPrice === "12.00",
      ) &&
      addPricesPlan.body.prices.some(
        (p: any) => p.currency === "php" && p.monthlyPrice === "680.00",
      ),
    `status ${addPricesPlan.status} ${JSON.stringify(addPricesPlan.body?.prices)}`,
  );

  // Full-replace: submitting `prices` again with only ONE currency removes the
  // other's plan_price row rather than leaving it stale.
  const replacePricesPlan = await req("PATCH", "/rpc-admin/plans/startup", {
    cookie: platformPlansAdminCk,
    headers: HDR,
    json: {
      prices: [{ currency: "aud", monthlyPrice: "18.00", annualPrice: "180.00" }],
    },
  });
  check(
    "txn: multi-currency PATCH full-replace drops unlisted currencies",
    replacePricesPlan.status === 200 &&
      Array.isArray(replacePricesPlan.body?.prices) &&
      replacePricesPlan.body.prices.length === 1 &&
      replacePricesPlan.body.prices[0]?.currency === "aud",
    `status ${replacePricesPlan.status} ${JSON.stringify(replacePricesPlan.body?.prices)}`,
  );

  // Built-in immutability — its planType is code-anchored, so a change is
  // refused; a pure metadata edit on the same built-in is allowed.
  const builtinTypeChange = await req("PATCH", "/rpc-admin/plans/pro", {
    cookie: platformPlansAdminCk,
    headers: HDR,
    json: { planType: "custom" },
  });
  check(
    "changing a built-in plan's type is refused (400)",
    builtinTypeChange.status === 400,
    `status ${builtinTypeChange.status}`,
  );
  const builtinMetaEdit = await req("PATCH", "/rpc-admin/plans/pro", {
    cookie: platformPlansAdminCk,
    headers: HDR,
    json: { description: "Advertised copy for Pro." },
  });
  check(
    "editing a built-in plan's advertised metadata is allowed (200)",
    builtinMetaEdit.status === 200 && builtinMetaEdit.body?.description === "Advertised copy for Pro.",
    `status ${builtinMetaEdit.status} ${JSON.stringify(builtinMetaEdit.body)}`,
  );

  const duplicatePlan = await req("POST", "/rpc-admin/plans/startup/duplicate", {
    cookie: platformPlansAdminCk,
    headers: HDR,
    json: { newKey: "startup-2", displayName: "Startup 2" },
  });
  check(
    "platform admin duplicates a plan into a custom draft (200)",
    duplicatePlan.status === 200 &&
      duplicatePlan.body?.key === "startup-2" &&
      duplicatePlan.body?.status === "draft" &&
      duplicatePlan.body?.planType === "custom",
    `status ${duplicatePlan.status} ${JSON.stringify(duplicatePlan.body)}`,
  );

  const deactivatePlan = await req("POST", "/rpc-admin/plans/startup/deactivate", {
    cookie: platformPlansAdminCk,
    headers: HDR,
  });
  check(
    "platform admin deactivates a plan with no subscribers (200 → draft)",
    deactivatePlan.status === 200 && deactivatePlan.body?.status === "draft",
    `status ${deactivatePlan.status} ${JSON.stringify(deactivatePlan.body)}`,
  );
  const archivePlan = await req("POST", "/rpc-admin/plans/startup/archive", {
    cookie: platformPlansAdminCk,
    headers: HDR,
  });
  check(
    "platform admin archives a plan with no subscribers (200 → archived)",
    archivePlan.status === 200 && archivePlan.body?.status === "archived",
    `status ${archivePlan.status} ${JSON.stringify(archivePlan.body)}`,
  );

  // Active-subscription guard — `pro` still has contoso's active subscription,
  // so both deactivate and archive are refused with a 409.
  const deactivateHeld = await req("POST", "/rpc-admin/plans/pro/deactivate", {
    cookie: platformPlansAdminCk,
    headers: HDR,
  });
  check(
    "deactivating a plan with an active subscription is refused (409)",
    deactivateHeld.status === 409,
    `status ${deactivateHeld.status} ${JSON.stringify(deactivateHeld.body)}`,
  );
  const archiveHeld = await req("POST", "/rpc-admin/plans/pro/archive", {
    cookie: platformPlansAdminCk,
    headers: HDR,
  });
  check(
    "archiving a plan with an active subscription is refused (409)",
    archiveHeld.status === 409,
    `status ${archiveHeld.status} ${JSON.stringify(archiveHeld.body)}`,
  );

  const mutateAsViewer = await req("POST", "/rpc-admin/plans/startup/activate", {
    cookie: platformViewerCk,
    headers: HDR,
  });
  check(
    "platform viewer cannot change a plan's status (403)",
    mutateAsViewer.status === 403,
    `status ${mutateAsViewer.status}`,
  );

  // Isolation — the catalog is platform-global (no tenant_id): the same list
  // comes back regardless of which tenant host the request carries, and its
  // per-plan rollup reflects only real tenant_subscription rows (pro = 1).
  const plansNoHost = await req("GET", "/rpc-admin/plans", { cookie: platformAdminCk });
  const plansWithHost = await req("GET", "/rpc-admin/plans", {
    cookie: platformAdminCk,
    slug: "contoso",
  });
  check(
    "plan catalog is platform-global — identical regardless of tenant host",
    plansNoHost.status === 200 &&
      plansWithHost.status === 200 &&
      plansNoHost.body?.meta?.totalItems === plansWithHost.body?.meta?.totalItems &&
      (plansNoHost.body?.items ?? []).length === (plansWithHost.body?.items ?? []).length,
    `${JSON.stringify(plansNoHost.body?.meta)} vs ${JSON.stringify(plansWithHost.body?.meta)}`,
  );

  // ── W1s. Subscriptions management surface (spec #6): rich cross-tenant list,
  //        per-tenant detail/history, the five named override actions, the
  //        permission gate, the billing-disabled state, cross-tenant isolation,
  //        and the Phase-1 `paused` status (override survives a webhook, and
  //        currentPeriodEnd is preserved through a status-only action). ──
  // Preconditions here: the plan catalog holds the built-in rows and contoso has
  // a pro/active subscription. acme's earlier subscription row does not survive
  // to this point in the run, so seed a deterministic pro/active row for the
  // assertions below. Billing is currently OFF (no STRIPE_SECRET_KEY set).
  await withTenant(acmeId, (tx) =>
    tx.insert(tenantSubscription).values({
      id: createId(),
      tenantId: acmeId,
      plan: "pro",
      status: "active",
      seats: 20,
    }),
  );
  const subsDisabled = await req("GET", "/rpc-admin/subscriptions", {
    cookie: platformAdminCk,
  });
  check(
    "subscriptions list degrades to { enabled:false } when billing is off",
    subsDisabled.status === 200 && subsDisabled.body?.enabled === false,
    JSON.stringify(subsDisabled.body),
  );

  // Enable billing for the remainder of this block (mirror-only — no live PSP
  // call is ever made from these routes); restored to off at the end.
  process.env.STRIPE_SECRET_KEY = "sk_test_e2e_subs";

  const subsList = await req("GET", "/rpc-admin/subscriptions", {
    cookie: platformAdminCk,
  });
  const acmeRow = (subsList.body?.items ?? []).find((r: any) => r.tenantId === acmeId);
  const contosoRow = (subsList.body?.items ?? []).find(
    (r: any) => r.tenantId === contosoId,
  );
  check(
    "subscriptions list (billing on) returns both tenants with catalog-joined plan label/price",
    subsList.status === 200 &&
      subsList.body?.enabled === true &&
      acmeRow?.planKey === "pro" &&
      acmeRow?.planLabel === "Pro" &&
      Number(acmeRow?.price) === 20 &&
      acmeRow?.displayStatus === "active" &&
      contosoRow?.planKey === "pro" &&
      contosoRow?.displayStatus === "active",
    JSON.stringify(subsList.body?.items),
  );

  const subsAsViewer = await req("GET", "/rpc-admin/subscriptions", {
    cookie: platformViewerCk,
  });
  check(
    "platform viewer can read the subscriptions list (billing:read)",
    subsAsViewer.status === 200 && subsAsViewer.body?.enabled === true,
    JSON.stringify(subsAsViewer.body),
  );

  // ── W0b (enabled-state): the cross-tenant billing rollup with billing ON.
  //     The W0b block earlier only proved the { enabled: false } degrade + read
  //     gate; here real tenantSubscription rows exist (acme + contoso both
  //     pro/active, before the override actions below mutate acme), so assert the
  //     summary counts and the paginated per-tenant rollup both light up, plus
  //     the /billing/tenants read gate that had no coverage at all. ──
  const billingSummaryOn = await req("GET", "/rpc-admin/billing/summary", {
    cookie: platformAdminCk,
  });
  check(
    "billing rollup summary (billing on) returns enabled:true with per-plan/status counts",
    billingSummaryOn.status === 200 &&
      billingSummaryOn.body?.enabled === true &&
      Array.isArray(billingSummaryOn.body?.counts) &&
      (billingSummaryOn.body?.counts ?? []).some(
        (r: any) => r.planId === "pro" && r.status === "active" && r.tenantCount >= 2,
      ),
    JSON.stringify(billingSummaryOn.body),
  );

  const billingTenantsOn = await req("GET", "/rpc-admin/billing/tenants", {
    cookie: platformAdminCk,
  });
  check(
    "billing per-tenant rollup (billing on) lists both tenants with pagination meta",
    billingTenantsOn.status === 200 &&
      billingTenantsOn.body?.enabled === true &&
      (billingTenantsOn.body?.items ?? []).some((r: any) => r.tenantId === acmeId) &&
      (billingTenantsOn.body?.items ?? []).some((r: any) => r.tenantId === contosoId) &&
      typeof billingTenantsOn.body?.meta?.totalItems === "number" &&
      billingTenantsOn.body.meta.totalItems >= 2,
    JSON.stringify(billingTenantsOn.body),
  );

  const billingTenantsAsViewer = await req("GET", "/rpc-admin/billing/tenants", {
    cookie: platformViewerCk,
  });
  check(
    "platform viewer reads the per-tenant billing rollup (billing:read)",
    billingTenantsAsViewer.status === 200 &&
      billingTenantsAsViewer.body?.enabled === true,
    JSON.stringify(billingTenantsAsViewer.body),
  );

  const billingTenantsAsOrdinary = await req("GET", "/rpc-admin/billing/tenants", {
    cookie: ownerCk,
  });
  check(
    "tenant owner with no platform role is blocked from the per-tenant billing rollup (403)",
    billingTenantsAsOrdinary.status === 403,
    `status ${billingTenantsAsOrdinary.status}`,
  );

  // Contract regression guard: manualOverride=false must NOT coerce to true.
  const subsNoOverride = await req(
    "GET",
    "/rpc-admin/subscriptions?manualOverride=false",
    { cookie: platformAdminCk },
  );
  check(
    "manualOverride=false filter returns only non-overridden rows (never coerced to true)",
    subsNoOverride.status === 200 &&
      (subsNoOverride.body?.items ?? []).length > 0 &&
      (subsNoOverride.body?.items ?? []).every((r: any) => r.manualOverride === false),
    JSON.stringify(subsNoOverride.body?.items),
  );

  // ── Permission + validation gates on the write actions ──
  const changePlanBody = {
    planKey: "enterprise" as const,
    reason: "e2e: upgrade acme to enterprise",
  };
  const changePlanNoHeader = await req(
    "POST",
    `/rpc-admin/subscriptions/${acmeId}/change-plan`,
    { cookie: platformAdminCk, json: changePlanBody },
  );
  check(
    "change-plan without the CSRF-preflight header is rejected (400)",
    changePlanNoHeader.status === 400,
    `status ${changePlanNoHeader.status}`,
  );
  const changePlanAsViewer = await req(
    "POST",
    `/rpc-admin/subscriptions/${acmeId}/change-plan`,
    { cookie: platformViewerCk, headers: HDR, json: changePlanBody },
  );
  check(
    "viewer cannot change-plan — read does not imply override_subscription (403)",
    changePlanAsViewer.status === 403,
    `status ${changePlanAsViewer.status}`,
  );
  const pauseAsViewer = await req(
    "POST",
    `/rpc-admin/subscriptions/${acmeId}/pause`,
    { cookie: platformViewerCk, headers: HDR, json: { reason: "e2e" } },
  );
  check(
    "viewer cannot pause a subscription (403)",
    pauseAsViewer.status === 403,
    `status ${pauseAsViewer.status}`,
  );
  const cancelAsViewer = await req(
    "POST",
    `/rpc-admin/subscriptions/${acmeId}/cancel`,
    { cookie: platformViewerCk, headers: HDR, json: { reason: "e2e" } },
  );
  check(
    "viewer cannot cancel a subscription (403)",
    cancelAsViewer.status === 403,
    `status ${cancelAsViewer.status}`,
  );
  const changePlanEmptyReason = await req(
    "POST",
    `/rpc-admin/subscriptions/${acmeId}/change-plan`,
    { cookie: platformAdminCk, headers: HDR, json: { ...changePlanBody, reason: "" } },
  );
  check(
    "empty reason is rejected (400)",
    changePlanEmptyReason.status === 400,
    `status ${changePlanEmptyReason.status}`,
  );
  const changePlanCustomKey = await req(
    "POST",
    `/rpc-admin/subscriptions/${acmeId}/change-plan`,
    { cookie: platformAdminCk, headers: HDR, json: { planKey: "startup", reason: "e2e" } },
  );
  check(
    "change-plan rejects a non-built-in plan key at the contract boundary (400)",
    changePlanCustomKey.status === 400,
    `status ${changePlanCustomKey.status}`,
  );

  // ── Happy path: change-plan → extend-trial → pause → resume → cancel ──
  const changePlan = await req(
    "POST",
    `/rpc-admin/subscriptions/${acmeId}/change-plan`,
    { cookie: platformAdminCk, headers: HDR, json: changePlanBody },
  );
  check(
    "platform admin changes acme's plan to enterprise (200)",
    changePlan.status === 200 && changePlan.body?.ok === true,
    JSON.stringify(changePlan.body),
  );
  const acmeAfterChange = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantSubscription),
  );
  check(
    "change-plan sets enterprise + seats -1 + manualOverride, keeps current status (active)",
    acmeAfterChange[0]?.plan === "enterprise" &&
      acmeAfterChange[0]?.seats === -1 &&
      acmeAfterChange[0]?.manualOverride === true &&
      acmeAfterChange[0]?.status === "active",
    JSON.stringify(acmeAfterChange[0]),
  );

  const trialEnd = new Date(Date.now() + 14 * 86_400_000);
  const extendTrial = await req(
    "POST",
    `/rpc-admin/subscriptions/${acmeId}/extend-trial`,
    {
      cookie: platformAdminCk,
      headers: HDR,
      json: { trialEndsAt: trialEnd.toISOString(), reason: "e2e: extend trial" },
    },
  );
  check(
    "platform admin extends acme's trial (200)",
    extendTrial.status === 200 && extendTrial.body?.ok === true,
    JSON.stringify(extendTrial.body),
  );
  const acmeAfterTrial = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantSubscription),
  );
  const trialPeriodEnd = acmeAfterTrial[0]?.currentPeriodEnd?.getTime();
  check(
    "extend-trial sets status trialing + a future currentPeriodEnd, preserves plan/seats (enterprise/-1)",
    acmeAfterTrial[0]?.status === "trialing" &&
      acmeAfterTrial[0]?.plan === "enterprise" &&
      acmeAfterTrial[0]?.seats === -1 &&
      typeof trialPeriodEnd === "number" &&
      trialPeriodEnd > Date.now(),
    JSON.stringify(acmeAfterTrial[0]),
  );

  const pause = await req("POST", `/rpc-admin/subscriptions/${acmeId}/pause`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { reason: "e2e: comp pause" },
  });
  check(
    "platform admin pauses acme (200)",
    pause.status === 200 && pause.body?.ok === true,
    JSON.stringify(pause.body),
  );
  const acmeAfterPause = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantSubscription),
  );
  check(
    "pause sets status paused; preserves plan/seats AND currentPeriodEnd (read-and-pass-through)",
    acmeAfterPause[0]?.status === "paused" &&
      acmeAfterPause[0]?.plan === "enterprise" &&
      acmeAfterPause[0]?.seats === -1 &&
      acmeAfterPause[0]?.manualOverride === true &&
      acmeAfterPause[0]?.currentPeriodEnd?.getTime() === trialPeriodEnd,
    JSON.stringify(acmeAfterPause[0]),
  );

  // paused → free entitlements (a working tier), an observable downgrade — NOT
  // a hard lockout (only `suspended` blocks access). Assert via the tenant's own
  // billing DTO: enterprise grants customDomains, free does not.
  const acmeBillingWhilePaused = await req("GET", "/rpc/billing", {
    slug: "acme",
    cookie: ownerCk,
  });
  check(
    "paused resolves to free entitlements (customDomains false), tenant still reachable",
    acmeBillingWhilePaused.status === 200 &&
      acmeBillingWhilePaused.body?.subscription?.entitlements?.customDomains === false,
    JSON.stringify(acmeBillingWhilePaused.body?.subscription),
  );

  // A signed webhook arrives while the paused override is active — it must be
  // suppressed (override wins), leaving status/plan/currentPeriodEnd untouched.
  const pausedEvt = {
    id: "evt_e2e_acme_paused_suppressed",
    type: "customer.subscription.updated",
    data: {
      object: {
        id: "sub_e2e_acme_paused",
        customer: "cus_e2e_acme_v2",
        status: "active",
        current_period_end: Math.floor(Date.now() / 1000) + 3600,
        metadata: { tenantId: acmeId, plan: "pro" },
      },
    },
  };
  const pausedPayload = JSON.stringify(pausedEvt);
  const pausedSig = signStripePayload(pausedPayload, "whsec_e2e_test_secret");
  const pausedHook = await postHook(pausedPayload, pausedSig);
  check(
    "webhook while the paused override is active is accepted (200)",
    pausedHook.status === 200 && pausedHook.body?.received === true,
    JSON.stringify(pausedHook.body),
  );
  const acmeAfterPausedHook = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantSubscription),
  );
  check(
    "paused override survives the webhook: still paused/enterprise, currentPeriodEnd preserved",
    acmeAfterPausedHook[0]?.status === "paused" &&
      acmeAfterPausedHook[0]?.plan === "enterprise" &&
      acmeAfterPausedHook[0]?.currentPeriodEnd?.getTime() === trialPeriodEnd,
    JSON.stringify(acmeAfterPausedHook[0]),
  );

  const subResume = await req("POST", `/rpc-admin/subscriptions/${acmeId}/resume`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { reason: "e2e: resume" },
  });
  check(
    "platform admin resumes acme (200)",
    subResume.status === 200 && subResume.body?.ok === true,
    JSON.stringify(subResume.body),
  );
  const acmeAfterResume = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantSubscription),
  );
  check(
    "resume sets status active, keeps enterprise/-1",
    acmeAfterResume[0]?.status === "active" &&
      acmeAfterResume[0]?.plan === "enterprise" &&
      acmeAfterResume[0]?.seats === -1,
    JSON.stringify(acmeAfterResume[0]),
  );

  const cancel = await req("POST", `/rpc-admin/subscriptions/${acmeId}/cancel`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { reason: "e2e: cancel comp" },
  });
  check(
    "platform admin cancels acme (200)",
    cancel.status === 200 && cancel.body?.ok === true,
    JSON.stringify(cancel.body),
  );
  const acmeAfterCancel = await withTenant(acmeId, (tx) =>
    tx.select().from(tenantSubscription),
  );
  check(
    "cancel sets status canceled, keeps enterprise/-1",
    acmeAfterCancel[0]?.status === "canceled" &&
      acmeAfterCancel[0]?.plan === "enterprise",
    JSON.stringify(acmeAfterCancel[0]),
  );

  // ── Detail + history ──
  const subDetail = await req("GET", `/rpc-admin/subscriptions/${acmeId}`, {
    cookie: platformAdminCk,
  });
  check(
    "subscription detail returns override metadata + catalog snapshot",
    subDetail.status === 200 &&
      subDetail.body?.planKey === "enterprise" &&
      subDetail.body?.manualOverride === true &&
      subDetail.body?.overrideReason === "e2e: cancel comp" &&
      subDetail.body?.planSnapshot?.key === "enterprise",
    JSON.stringify(subDetail.body),
  );
  const subHistory = await req("GET", `/rpc-admin/subscriptions/${acmeId}/history`, {
    cookie: platformAdminCk,
  });
  const historySources = (subHistory.body?.items ?? []).map((e: any) => e.source);
  check(
    "billing history reflects the override transitions (manual_override rows written)",
    subHistory.status === 200 &&
      (subHistory.body?.items ?? []).length >= 4 &&
      historySources.includes("manual_override"),
    JSON.stringify((subHistory.body?.items ?? []).slice(0, 4)),
  );

  // ── Cross-tenant isolation + not-found ──
  const contosoAfterAcmeActions = await withTenant(contosoId, (tx) =>
    tx.select().from(tenantSubscription),
  );
  check(
    "cross-tenant isolation: contoso's subscription is untouched by acme's action flow (pro/active, no override)",
    contosoAfterAcmeActions[0]?.plan === "pro" &&
      contosoAfterAcmeActions[0]?.status === "active" &&
      contosoAfterAcmeActions[0]?.manualOverride === false,
    JSON.stringify(contosoAfterAcmeActions[0]),
  );
  const subDetailMissing = await req(
    "GET",
    "/rpc-admin/subscriptions/nonexistent-tenant-id",
    { cookie: platformAdminCk },
  );
  check(
    "subscription detail for a nonexistent tenant 404s",
    subDetailMissing.status === 404,
    `status ${subDetailMissing.status}`,
  );
  const changePlanMissing = await req(
    "POST",
    "/rpc-admin/subscriptions/nonexistent-tenant-id/change-plan",
    { cookie: platformAdminCk, headers: HDR, json: changePlanBody },
  );
  check(
    "change-plan on a nonexistent tenant 404s",
    changePlanMissing.status === 404,
    `status ${changePlanMissing.status}`,
  );

  // Restore billing to OFF so later blocks see the same environment they expect.
  delete process.env.STRIPE_SECRET_KEY;
  // Drop the acme subscription row seeded for this block, restoring the state
  // later blocks expect.
  await withTenant(acmeId, (tx) => tx.delete(tenantSubscription));

  // Cleanup: drop contoso's seeded subscription so the destructive delete block
  // below starts from the same state it expected.
  await withTenant(contosoId, (tx) => tx.delete(tenantSubscription));
  // ── W2. Platform integrations store (per-category connection surface). ──
  // A DEDICATED admin (fresh userId → fresh `mutateLimiter` bucket): section W
  // above already spends much of `platformAdminUser`'s 20-per-60s allowance, so
  // this block's ~half-dozen mutations would otherwise trip the limiter.
  const intAdminUser = await ensureStaff("platform-int-admin@e2e.test", "Integrations Admin");
  await adminDb
    .update(schema.user)
    .set({ platformRole: "admin", role: null })
    .where(eq(schema.user.id, intAdminUser));
  const intAdminCk = await staffCookie("platform-int-admin@e2e.test");
  const INT = "/rpc-admin/integrations";
  const intCat = (body: any, category: string) =>
    (body?.integrations ?? []).find((x: any) => x.category === category);

  const intList = await req("GET", INT, { cookie: intAdminCk });
  check(
    "platform admin lists every integration category (200, all 9)",
    intList.status === 200 && (intList.body?.integrations ?? []).length === 9,
    `status ${intList.status} ${JSON.stringify(intList.body?.integrations?.length)}`,
  );
  check(
    "payment reflects real env credential presence (no STRIPE_SECRET_KEY → false) and is testable",
    intCat(intList.body, "payment")?.hasCredentials === false &&
      intCat(intList.body, "payment")?.testable === true,
    JSON.stringify(intCat(intList.body, "payment")),
  );
  check(
    "no integration in the list response carries a secret/secretEnc field",
    (intList.body?.integrations ?? []).every(
      (x: any) => !("secret" in x) && !("secretEnc" in x),
    ),
    JSON.stringify(Object.keys((intList.body?.integrations ?? [])[0] ?? {})),
  );

  // Role gate: viewer reads, but cannot configure or test.
  const intAsViewer = await req("GET", INT, { cookie: platformViewerCk });
  check("platform viewer reads integrations (200)", intAsViewer.status === 200, `status ${intAsViewer.status}`);
  const intViewerPatch = await req("PATCH", `${INT}/monitoring`, {
    cookie: platformViewerCk,
    headers: HDR,
    json: { action: "configure", config: { environment: "prod" } },
  });
  check(
    "platform viewer cannot configure an integration (403)",
    intViewerPatch.status === 403,
    `status ${intViewerPatch.status}`,
  );
  const intViewerTest = await req("POST", `${INT}/payment/test`, {
    cookie: platformViewerCk,
    headers: HDR,
    json: {},
  });
  check(
    "platform viewer cannot test an integration (403)",
    intViewerTest.status === 403,
    `status ${intViewerTest.status}`,
  );
  const intNoHeader = await req("PATCH", `${INT}/monitoring`, {
    cookie: intAdminCk,
    json: { action: "configure", config: { environment: "prod" } },
  });
  check(
    "integration write without the CSRF-preflight header is rejected (400)",
    intNoHeader.status === 400,
    `status ${intNoHeader.status}`,
  );
  // Tenant authority grants no platform authority.
  const intAsOwner = await req("GET", INT, { cookie: ownerCk });
  check(
    "tenant owner cannot read platform integrations (403)",
    intAsOwner.status === 403,
    `status ${intAsOwner.status}`,
  );

  // Happy path: admin configures non-secret config and it persists.
  const intConfigure = await req("PATCH", `${INT}/monitoring`, {
    cookie: intAdminCk,
    headers: HDR,
    json: { action: "configure", config: { environment: "production", release: "v1.2.3" } },
  });
  check(
    "admin configures a non-secret config and it round-trips (200)",
    intConfigure.status === 200 &&
      intConfigure.body?.config?.environment === "production" &&
      intConfigure.body?.config?.release === "v1.2.3",
    `status ${intConfigure.status} ${JSON.stringify(intConfigure.body?.config)}`,
  );
  const intReload = await req("GET", `${INT}/monitoring`, { cookie: intAdminCk });
  check(
    "the configured value persists across a fresh read",
    intReload.body?.config?.environment === "production",
    JSON.stringify(intReload.body?.config),
  );
  // Unknown config key is refused (validated against the registry field spec).
  const intBadKey = await req("PATCH", `${INT}/monitoring`, {
    cookie: intAdminCk,
    headers: HDR,
    json: { config: { notARealField: "x" } },
  });
  check(
    "an unknown config field is refused (400)",
    intBadKey.status === 400,
    `status ${intBadKey.status} ${JSON.stringify(intBadKey.body)}`,
  );

  // Secret path: a category that accepts a stored secret (sms). The secret is
  // encrypted server-side and must NEVER appear in any response.
  const SMS_SECRET = "super-secret-sms-key-e2e";
  const intSecret = await req("PATCH", `${INT}/sms`, {
    cookie: intAdminCk,
    headers: HDR,
    json: { action: "configure", secret: SMS_SECRET, config: { senderId: "Agora" } },
  });
  check(
    "admin stores a runtime secret (200, hasStoredSecret true, config saved)",
    intSecret.status === 200 &&
      intSecret.body?.hasStoredSecret === true &&
      intSecret.body?.config?.senderId === "Agora",
    `status ${intSecret.status} ${JSON.stringify(intSecret.body)}`,
  );
  check(
    "the configure response never echoes the plaintext secret",
    intSecret.status === 200 &&
      !("secret" in (intSecret.body ?? {})) &&
      JSON.stringify(intSecret.body).indexOf(SMS_SECRET) === -1,
    JSON.stringify(intSecret.body),
  );
  const smsReload = await req("GET", `${INT}/sms`, { cookie: intAdminCk });
  check(
    "a stored secret is never returned by any subsequent read",
    smsReload.body?.hasStoredSecret === true &&
      JSON.stringify(smsReload.body).indexOf(SMS_SECRET) === -1,
    JSON.stringify(smsReload.body),
  );
  // A stored secret is refused where the category is strictly env-configured.
  const intSecretRefused = await req("PATCH", `${INT}/payment`, {
    cookie: intAdminCk,
    headers: HDR,
    json: { secret: "should-be-refused" },
  });
  check(
    "storing a secret on an env-only category is refused (400)",
    intSecretRefused.status === 400,
    `status ${intSecretRefused.status} ${JSON.stringify(intSecretRefused.body)}`,
  );

  // Test-connection: a real, non-fabricated result. Payment is testable but has
  // no STRIPE_SECRET_KEY in this env, so the probe fails honestly with NO
  // network call, and the failure is persisted + reflected.
  const intTestPayment = await req("POST", `${INT}/payment/test`, {
    cookie: intAdminCk,
    headers: HDR,
    json: {},
  });
  check(
    "a testable integration reports a REAL failure (no key), never a fabricated pass",
    intTestPayment.status === 200 &&
      intTestPayment.body?.testable === true &&
      intTestPayment.body?.ok === false &&
      intTestPayment.body?.connectionStatus === "error" &&
      intTestPayment.body?.lastSuccessfulConnectionAt === null,
    JSON.stringify(intTestPayment.body),
  );
  // A non-testable category says so plainly and changes nothing.
  const intTestMon = await req("POST", `${INT}/monitoring/test`, {
    cookie: intAdminCk,
    headers: HDR,
    json: {},
  });
  check(
    "a non-testable category reports testable:false and never a synthesized status",
    intTestMon.status === 200 &&
      intTestMon.body?.testable === false &&
      intTestMon.body?.ok === false,
    JSON.stringify(intTestMon.body),
  );

  // Disconnect is a soft state change: the row (and its stored secret) is
  // retained, only enabled/connectionStatus change.
  await req("PATCH", `${INT}/sms`, {
    cookie: intAdminCk,
    headers: HDR,
    json: { action: "connect", enabled: true },
  });
  const intDisconnect = await req("PATCH", `${INT}/sms`, {
    cookie: intAdminCk,
    headers: HDR,
    json: { action: "disconnect" },
  });
  check(
    "disconnect disables + marks disconnected but retains the row/secret",
    intDisconnect.status === 200 &&
      intDisconnect.body?.enabled === false &&
      intDisconnect.body?.connectionStatus === "disconnected" &&
      intDisconnect.body?.hasStoredSecret === true,
    JSON.stringify(intDisconnect.body),
  );

  // Every mutating action is audited (configure + test outcome), never the secret.
  const intAudit = await req("GET", "/rpc-admin/audit", { cookie: platformViewerCk });
  const intAuditActions = new Set<string>(
    (intAudit.body?.items ?? []).map((r: any) => r.action as string),
  );
  check(
    "integration configure + test outcomes landed in the platform audit log",
    intAuditActions.has("platform.integration.configure") &&
      intAuditActions.has("platform.integration.test"),
    JSON.stringify([...intAuditActions].filter((a) => a.startsWith("platform.integration"))),
  );
  check(
    "no integration audit row's metadata carries the plaintext secret",
    (intAudit.body?.items ?? [])
      .filter((r: any) => (r.action as string).startsWith("platform.integration"))
      .every((r: any) => JSON.stringify(r.metadata ?? {}).indexOf(SMS_SECRET) === -1),
  );
  check(
    "platform_integration is NOT RLS-scoped (absent from both tenant table sets)",
    !(APP_TENANT_TABLES as readonly string[]).includes("PlatformIntegrations") &&
      !(BASE_TENANT_TABLES as readonly string[]).includes("PlatformIntegrations"),
  );
  check(
    "platform_integration_account is NOT RLS-scoped (absent from both tenant table sets)",
    !(APP_TENANT_TABLES as readonly string[]).includes("PlatformIntegrationAccounts") &&
      !(BASE_TENANT_TABLES as readonly string[]).includes("PlatformIntegrationAccounts"),
  );
  check(
    "job is NOT RLS-scoped (absent from both tenant table sets) — the generic " +
      "queue table backing every named queue (email, webhooks, ...), written by " +
      "system-level dispatchers with no tenant context, only ever drained " +
      "cross-tenant by each queue's poller (.ai/plans/agora/active/general-job-queue)",
    !(APP_TENANT_TABLES as readonly string[]).includes("Jobs") &&
      !(BASE_TENANT_TABLES as readonly string[]).includes("Jobs"),
  );

  // ── W3. Platform API keys & webhooks (cross-tenant view + incident
  //        actions, spec #16). Reads span tenants via `withAdmin`; mutations
  //        (revoke/rotate keys, retry/disable webhooks) are permission-gated,
  //        CSRF-header-guarded, audited, and scoped to the row's own tenant. ──
  // Fresh, usable keys minted through the tenant surface (so we can prove a
  // real secret stops authenticating after a platform revoke/rotate).
  const w3AcmeKey = await req("POST", "/rpc/api-keys", {
    slug: "acme",
    cookie: ownerCk,
    json: { name: "w3 acme revoke", role: "admin" },
  });
  const w3AcmeSecret = w3AcmeKey.body?.apiKey?.secret as string;
  const w3AcmeKeyId = w3AcmeKey.body?.apiKey?.id as string;
  const w3RotKey = await req("POST", "/rpc/api-keys", {
    slug: "acme",
    cookie: ownerCk,
    json: { name: "w3 acme rotate", role: "admin" },
  });
  const w3RotSecret = w3RotKey.body?.apiKey?.secret as string;
  const w3RotKeyId = w3RotKey.body?.apiKey?.id as string;
  const w3ContosoKey = await req("POST", "/rpc/api-keys", {
    slug: "contoso",
    cookie: contosoOwnerCk,
    json: { name: "w3 contoso key", role: "admin" },
  });
  const w3ContosoKeyId = w3ContosoKey.body?.apiKey?.id as string;

  // (a) Happy path: the platform list spans BOTH tenants and never leaks a hash.
  const pkListAdmin = await req("GET", "/rpc-admin/api-keys", { cookie: platformAdminCk });
  const pkRows: any[] = pkListAdmin.body?.items ?? [];
  check(
    "platform api-keys list spans tenants (acme + contoso rows present)",
    pkListAdmin.status === 200 &&
      pkRows.some((k) => k.id === w3AcmeKeyId && k.tenantId === acmeId) &&
      pkRows.some((k) => k.id === w3ContosoKeyId && k.tenantId === contosoId),
    `status ${pkListAdmin.status}`,
  );
  check(
    "platform api-key rows carry tenant attribution but NO hash/secret",
    pkRows.every(
      (k) =>
        k.keyHash === undefined &&
        k.secret === undefined &&
        typeof k.tenantName === "string" &&
        (k.status === "active" || k.status === "revoked"),
    ),
    JSON.stringify(pkRows[0] ?? {}),
  );

  // (b) Read gate: viewer may read; an ordinary tenant owner is blocked.
  const pkListViewer = await req("GET", "/rpc-admin/api-keys", { cookie: platformViewerCk });
  check("platform viewer may read api-keys (read floor)", pkListViewer.status === 200);
  const pkListOrdinary = await req("GET", "/rpc-admin/api-keys", { cookie: ownerCk });
  check(
    "tenant owner with no platform role blocked from api-keys list (403)",
    pkListOrdinary.status === 403,
    `status ${pkListOrdinary.status}`,
  );

  // (c) Revoke gates + effect.
  const revNoHeader = await req("POST", `/rpc-admin/api-keys/${w3AcmeKeyId}/revoke`, {
    cookie: platformAdminCk,
  });
  check(
    "platform api-key revoke without CSRF header rejected (400)",
    revNoHeader.status === 400,
    `status ${revNoHeader.status}`,
  );
  const revViewer = await req("POST", `/rpc-admin/api-keys/${w3AcmeKeyId}/revoke`, {
    cookie: platformViewerCk,
    headers: HDR,
  });
  check(
    "platform viewer blocked from revoking api key (403)",
    revViewer.status === 403,
    `status ${revViewer.status}`,
  );
  // Confirm the secret authenticates BEFORE the revoke.
  const w3PreRevoke = await req("GET", "/rpc/me", { slug: "acme", bearer: w3AcmeSecret });
  check("w3 acme key authenticates before revoke (200)", w3PreRevoke.status === 200);
  const revAdmin = await req("POST", `/rpc-admin/api-keys/${w3AcmeKeyId}/revoke`, {
    cookie: platformAdminCk,
    headers: HDR,
  });
  check("platform admin revokes api key (200)", revAdmin.status === 200, `status ${revAdmin.status}`);
  const w3PostRevoke = await req("GET", "/rpc/me", { slug: "acme", bearer: w3AcmeSecret });
  check(
    "platform-revoked key no longer authenticates (401)",
    w3PostRevoke.status === 401,
    `status ${w3PostRevoke.status}`,
  );

  // (d) Rotate gates + one-time new secret + old secret dies.
  const rotViewer = await req("POST", `/rpc-admin/api-keys/${w3RotKeyId}/rotate`, {
    cookie: platformViewerCk,
    headers: HDR,
  });
  check(
    "platform viewer blocked from rotating api key (403)",
    rotViewer.status === 403,
    `status ${rotViewer.status}`,
  );
  const rotAdmin = await req("POST", `/rpc-admin/api-keys/${w3RotKeyId}/rotate`, {
    cookie: platformAdminCk,
    headers: HDR,
  });
  const w3NewSecret = rotAdmin.body?.apiKey?.secret as string | undefined;
  check(
    "platform admin rotates api key (201 + one-time new secret, no hash)",
    rotAdmin.status === 201 &&
      typeof w3NewSecret === "string" &&
      w3NewSecret.startsWith("agora_") &&
      rotAdmin.body?.apiKey?.keyHash === undefined,
    `status ${rotAdmin.status}`,
  );
  const rotOld = await req("GET", "/rpc/me", { slug: "acme", bearer: w3RotSecret });
  check("rotated-away old secret no longer authenticates (401)", rotOld.status === 401, `status ${rotOld.status}`);
  const rotNew = await req("GET", "/rpc/me", { slug: "acme", bearer: w3NewSecret });
  check(
    "rotated new secret authenticates as the same tenant + role (200)",
    rotNew.status === 200 && rotNew.body?.tenantSlug === "acme" && rotNew.body?.role === "admin",
    `status ${rotNew.status} ${JSON.stringify(rotNew.body)}`,
  );

  // Seed webhook endpoints in BOTH tenants + a FAILED delivery in acme.
  const [w3Ep] = await withTenant(acmeId, (tx) =>
    tx
      .insert(webhookEndpoint)
      .values({
        id: createId(),
        tenantId: acmeId,
        url: "https://w3-acme.example.test/hook",
        secret: "whsec_w3_acme",
        events: ["project.created"],
        enabled: true,
      })
      .returning(),
  );
  const [w3Del] = await withTenant(acmeId, (tx) =>
    tx
      .insert(job)
      .values({
        id: createId(),
        queue: "webhooks",
        type: "deliver-webhook",
        tenantId: acmeId,
        payload: { endpointId: w3Ep!.id, event: "project.created", body: { hello: "w3" } },
        status: "failed",
        attempts: 6,
        result: { responseCode: 500 },
        lastError: "HTTP 500",
        nextAttemptAt: new Date(),
      })
      .returning(),
  );
  const [w3EpC] = await withTenant(contosoId, (tx) =>
    tx
      .insert(webhookEndpoint)
      .values({
        id: createId(),
        tenantId: contosoId,
        url: "https://w3-contoso.example.test/hook",
        secret: "whsec_w3_contoso",
        events: ["project.created"],
        enabled: true,
      })
      .returning(),
  );

  // (e) Happy path: platform webhooks list spans tenants, never leaks the secret.
  const whListAdmin = await req("GET", "/rpc-admin/webhooks", { cookie: platformAdminCk });
  const whRows: any[] = whListAdmin.body?.items ?? [];
  check(
    "platform webhooks list spans tenants (acme + contoso endpoints present)",
    whListAdmin.status === 200 &&
      whRows.some((w) => w.id === w3Ep!.id && w.tenantId === acmeId) &&
      whRows.some((w) => w.id === w3EpC!.id && w.tenantId === contosoId),
    `status ${whListAdmin.status}`,
  );
  check(
    "platform webhook rows carry the delivery rollup but NO signing secret",
    whRows.every(
      (w) =>
        w.secret === undefined &&
        typeof w.tenantName === "string" &&
        typeof w.pendingCount === "number",
    ),
    JSON.stringify(whRows[0] ?? {}),
  );

  // Delivery log route (scoped to the endpoint's own tenant, read via withAdmin).
  const pfDeliveries = await req("GET", `/rpc-admin/webhooks/${w3Ep!.id}/deliveries`, {
    cookie: platformAdminCk,
  });
  const whDelRows: any[] = pfDeliveries.body?.items ?? [];
  check(
    "platform delivery log lists the endpoint's deliveries (own tenant only)",
    pfDeliveries.status === 200 &&
      whDelRows.some((d) => d.id === w3Del!.id) &&
      whDelRows.every((d) => d.tenantId === acmeId),
    `status ${whDeliveries.status}`,
  );

  // (f) Retry gates + effect (reset attempts to 0, re-enqueue as pending).
  const retryNoHeader = await req(
    "POST",
    `/rpc-admin/webhooks/${w3Ep!.id}/deliveries/${w3Del!.id}/retry`,
    { cookie: platformAdminCk },
  );
  check(
    "platform delivery retry without CSRF header rejected (400)",
    retryNoHeader.status === 400,
    `status ${retryNoHeader.status}`,
  );
  const retryViewer = await req(
    "POST",
    `/rpc-admin/webhooks/${w3Ep!.id}/deliveries/${w3Del!.id}/retry`,
    { cookie: platformViewerCk, headers: HDR },
  );
  check(
    "platform viewer blocked from retrying a delivery (403)",
    retryViewer.status === 403,
    `status ${retryViewer.status}`,
  );
  const retryAdmin = await req(
    "POST",
    `/rpc-admin/webhooks/${w3Ep!.id}/deliveries/${w3Del!.id}/retry`,
    { cookie: platformAdminCk, headers: HDR },
  );
  check("platform admin retries a failed delivery (200)", retryAdmin.status === 200, `status ${retryAdmin.status}`);
  const [w3DelAfter] = await withTenant(acmeId, (tx) =>
    tx.select().from(job).where(eq(job.id, w3Del!.id)),
  );
  check(
    "retried delivery is re-enqueued: status=pending + attempts reset to 0",
    w3DelAfter?.status === "pending" && w3DelAfter?.attempts === 0,
    JSON.stringify({ status: w3DelAfter?.status, attempts: w3DelAfter?.attempts }),
  );

  // Disable gates + effect.
  const disViewer = await req("POST", `/rpc-admin/webhooks/${w3Ep!.id}/disable`, {
    cookie: platformViewerCk,
    headers: HDR,
  });
  check(
    "platform viewer blocked from disabling an endpoint (403)",
    disViewer.status === 403,
    `status ${disViewer.status}`,
  );
  const disAdmin = await req("POST", `/rpc-admin/webhooks/${w3Ep!.id}/disable`, {
    cookie: platformAdminCk,
    headers: HDR,
  });
  check("platform admin disables an endpoint (200)", disAdmin.status === 200, `status ${disAdmin.status}`);
  const [w3EpAfter] = await withTenant(acmeId, (tx) =>
    tx.select().from(webhookEndpoint).where(eq(webhookEndpoint.id, w3Ep!.id)),
  );
  check(
    "disabled endpoint has enabled=false + disabledAt set",
    w3EpAfter?.enabled === false && w3EpAfter?.disabledAt !== null,
    JSON.stringify({ enabled: w3EpAfter?.enabled, disabledAt: w3EpAfter?.disabledAt }),
  );
  // A disabled endpoint refuses a further retry with a clear error (the worker
  // would otherwise terminate the delivery without sending).
  const retryDisabled = await req(
    "POST",
    `/rpc-admin/webhooks/${w3Ep!.id}/deliveries/${w3Del!.id}/retry`,
    { cookie: platformAdminCk, headers: HDR },
  );
  check(
    "retry on a disabled endpoint is refused (400)",
    retryDisabled.status === 400,
    `status ${retryDisabled.status}`,
  );

  // ── Generic job retry (any queue/type), general-job-queue follow-up
  //    (.ai/plans/agora/active/sms-provider-and-job-retry) ──
  const [genJob1] = await withAdmin((tx) =>
    tx
      .insert(job)
      .values({
        id: createId(),
        queue: "webhooks",
        type: "deliver-webhook",
        tenantId: acmeId,
        payload: { endpointId: w3Ep!.id, event: "project.created", body: { hello: "generic" } },
        status: "failed",
        attempts: 6,
        maxAttempts: 6,
        lastError: "HTTP 500",
      })
      .returning(),
  );
  const genRetryViewer = await req("POST", `/rpc-admin/jobs/${genJob1!.id}/retry`, {
    cookie: platformViewerCk,
    headers: HDR,
  });
  check(
    "platform viewer blocked from generic job retry (403)",
    genRetryViewer.status === 403,
    `status ${genRetryViewer.status}`,
  );
  const genRetryAdmin = await req("POST", `/rpc-admin/jobs/${genJob1!.id}/retry`, {
    cookie: platformAdminCk,
    headers: HDR,
  });
  check(
    "platform admin retries a generic failed job (200)",
    genRetryAdmin.status === 200 && genRetryAdmin.body?.retried === 1,
    `status ${genRetryAdmin.status} ${JSON.stringify(genRetryAdmin.body)}`,
  );
  const [genJob1After] = await withAdmin((tx) =>
    tx.select().from(job).where(eq(job.id, genJob1!.id)),
  );
  check(
    "generic retry resets attempts to 0 and status to pending",
    genJob1After?.status === "pending" && genJob1After?.attempts === 0,
    JSON.stringify({ status: genJob1After?.status, attempts: genJob1After?.attempts }),
  );
  const genRetryAgain = await req("POST", `/rpc-admin/jobs/${genJob1!.id}/retry`, {
    cookie: platformAdminCk,
    headers: HDR,
  });
  check(
    "retrying a non-failed job is refused (400)",
    genRetryAgain.status === 400,
    `status ${genRetryAgain.status}`,
  );

  // Batch retry — seed 2 more failed jobs on the "webhooks" queue + 1 untouched
  // pending job, then retry the whole queue in one call.
  const [genJob2, genJob3] = await withAdmin((tx) =>
    tx
      .insert(job)
      .values([
        {
          id: createId(),
          queue: "webhooks",
          type: "deliver-webhook",
          tenantId: acmeId,
          payload: { endpointId: w3Ep!.id, event: "project.created", body: { x: 2 } },
          status: "failed",
          attempts: 6,
          maxAttempts: 6,
          lastError: "HTTP 500",
        },
        {
          id: createId(),
          queue: "webhooks",
          type: "deliver-webhook",
          tenantId: acmeId,
          payload: { endpointId: w3Ep!.id, event: "project.created", body: { x: 3 } },
          status: "failed",
          attempts: 6,
          maxAttempts: 6,
          lastError: "HTTP 500",
        },
      ])
      .returning(),
  );
  const [untouchedPending] = await withAdmin((tx) =>
    tx
      .insert(job)
      .values({
        id: createId(),
        queue: "webhooks",
        type: "deliver-webhook",
        tenantId: acmeId,
        payload: { endpointId: w3Ep!.id, event: "project.created", body: { x: 4 } },
        status: "pending",
        attempts: 0,
        maxAttempts: 6,
      })
      .returning(),
  );
  const batchNoFilter = await req("POST", "/rpc-admin/jobs/retry", {
    cookie: platformAdminCk,
    headers: HDR,
    json: {},
  });
  check(
    "batch retry with no queue/ids filter is refused (400)",
    batchNoFilter.status === 400,
    `status ${batchNoFilter.status}`,
  );
  const batchRetry = await req("POST", "/rpc-admin/jobs/retry", {
    cookie: platformAdminCk,
    headers: HDR,
    json: { queue: "webhooks" },
  });
  check(
    "batch retry on the webhooks queue retries at least the 2 seeded failed jobs (200)",
    batchRetry.status === 200 && (batchRetry.body?.retried ?? 0) >= 2,
    `status ${batchRetry.status} ${JSON.stringify(batchRetry.body)}`,
  );
  const [genJob2After, genJob3After, untouchedAfter] = await withAdmin((tx) =>
    tx
      .select()
      .from(job)
      .where(
        sql`${job.id} IN (${genJob2!.id}, ${genJob3!.id}, ${untouchedPending!.id})`,
      ),
  ).then((rows) => [
    rows.find((r) => r.id === genJob2!.id),
    rows.find((r) => r.id === genJob3!.id),
    rows.find((r) => r.id === untouchedPending!.id),
  ]);
  check(
    "batch retry reset both seeded failed jobs to pending/attempts=0",
    genJob2After?.status === "pending" &&
      genJob2After?.attempts === 0 &&
      genJob3After?.status === "pending" &&
      genJob3After?.attempts === 0,
    JSON.stringify({ genJob2After, genJob3After }),
  );
  check(
    "batch retry left the already-pending job untouched (attempts still 0, same row)",
    untouchedAfter?.status === "pending" && untouchedAfter?.attempts === 0,
    JSON.stringify(untouchedAfter),
  );

  // ── Minimal SMS smoke check (default console provider always succeeds) ──
  const { sendTransactionalSms } = await import("agora/server");
  const smsResult = await sendTransactionalSms({ to: "+15550001111", body: "e2e sms test" });
  check(
    "sendTransactionalSms with the default console provider succeeds immediately",
    smsResult.queued === false,
    JSON.stringify(smsResult),
  );

  // (g) Tenant isolation: the cross-tenant platform view never leaks INTO the
  // tenant path — acme's own tenant-scoped lists still show only acme's rows.
  const acmeKeysScoped = await req("GET", "/rpc/api-keys", { slug: "acme", cookie: ownerCk });
  check(
    "tenant api-key list stays scoped: acme never sees contoso's key",
    acmeKeysScoped.status === 200 &&
      !(acmeKeysScoped.body?.keys ?? []).some((k: any) => k.id === w3ContosoKeyId),
    `status ${acmeKeysScoped.status}`,
  );
  const acmeWhScoped = await req("GET", "/rpc/webhooks", { slug: "acme", cookie: ownerCk });
  check(
    "tenant webhook list stays scoped: acme never sees contoso's endpoint",
    acmeWhScoped.status === 200 &&
      !(acmeWhScoped.body?.endpoints ?? []).some((w: any) => w.id === w3EpC!.id),
    `status ${acmeWhScoped.status}`,
  );

  // ── W4. Native support tickets (spec #10): read/manage gate, happy path,
  //     cross-org filter isolation. Platform-global (NOT RLS-scoped) — the
  //     isolation property that applies is org-filter correctness, proven
  //     here; the tables staying non-RLS is guaranteed by their absence from
  //     APP_TENANT_TABLES + no FORCE-RLS in migration 0033 (reviewed by eye). ──
  const ST = "/rpc-admin/support-tickets";

  // Read floor: viewer may list; an ordinary tenant owner may not.
  const stListViewer = await req("GET", ST, { cookie: platformViewerCk });
  check("support tickets: viewer may list (read floor)", stListViewer.status === 200, `status ${stListViewer.status}`);
  const stListOrdinary = await req("GET", ST, { cookie: ownerCk });
  check("support tickets: ordinary owner blocked from list (403)", stListOrdinary.status === 403, `status ${stListOrdinary.status}`);

  // Manage gate: viewer cannot create.
  const stCreateViewer = await req("POST", ST, {
    cookie: platformViewerCk,
    headers: HDR,
    json: { organizationId: acmeId, subject: "viewer attempt", body: "nope" },
  });
  check("support tickets: viewer cannot create — read does not imply manage (403)", stCreateViewer.status === 403, `status ${stCreateViewer.status}`);

  // Create against a bogus org → 404 (never trust a client org id).
  const stCreateBadOrg = await req("POST", ST, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { organizationId: "does-not-exist", subject: "x", body: "y" },
  });
  check("support tickets: create against unknown org → 404", stCreateBadOrg.status === 404, `status ${stCreateBadOrg.status}`);

  // Happy path: admin creates a ticket for acme with an opening message.
  const stCreate = await req("POST", ST, {
    cookie: platformAdminCk,
    headers: HDR,
    json: {
      organizationId: acmeId,
      subject: "Acme cannot export data",
      priority: "high",
      requesterLabel: "jane@acme.test",
      body: "The CSV export button 500s.",
    },
  });
  check(
    "support tickets: admin creates a ticket (200) with opening message + status open",
    stCreate.status === 200 &&
      stCreate.body?.organizationId === acmeId &&
      stCreate.body?.status === "open" &&
      stCreate.body?.priority === "high" &&
      (stCreate.body?.messages ?? []).length === 1 &&
      stCreate.body?.messages?.[0]?.internal === false,
    `status ${stCreate.status} ${JSON.stringify(stCreate.body)}`,
  );
  const stTicketId = stCreate.body?.id as string;

  // Reply (visible) + internal note; both land, distinctly flagged.
  const stReply = await req("POST", `${ST}/${stTicketId}/messages`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { body: "Looking into it now.", internal: false },
  });
  const stNote = await req("POST", `${ST}/${stTicketId}/messages`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { body: "Repro'd on staging — worker OOM.", internal: true },
  });
  check(
    "support tickets: reply + internal note both persist, distinctly flagged",
    stReply.status === 200 &&
      stNote.status === 200 &&
      (stNote.body?.messages ?? []).length === 3 &&
      stNote.body?.messages?.some((m: any) => m.internal === true) &&
      stNote.body?.messages?.some((m: any) => m.internal === false),
    `reply ${stReply.status} note ${stNote.status} ${JSON.stringify(stNote.body?.messages?.length)}`,
  );

  // Assign to a staff agent while open → auto-moves to assigned.
  const stAssign = await req("PATCH", `${ST}/${stTicketId}`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { assignedAgentId: platformAdminUser },
  });
  check(
    "support tickets: assigning an agent to an open ticket moves it to assigned",
    stAssign.status === 200 &&
      stAssign.body?.assignedAgentId === platformAdminUser &&
      stAssign.body?.status === "assigned",
    `status ${stAssign.status} ${JSON.stringify(stAssign.body)}`,
  );

  // Move to resolved → resolvedAt set. Then to pending → resolvedAt cleared.
  const stResolve = await req("PATCH", `${ST}/${stTicketId}`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { status: "resolved" },
  });
  check(
    "support tickets: status→resolved sets resolvedAt",
    stResolve.status === 200 && stResolve.body?.status === "resolved" && !!stResolve.body?.resolvedAt,
    `status ${stResolve.status} ${JSON.stringify(stResolve.body?.resolvedAt)}`,
  );
  const stReopen = await req("PATCH", `${ST}/${stTicketId}`, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { status: "pending" },
  });
  check(
    "support tickets: leaving resolved clears resolvedAt",
    stReopen.status === 200 && stReopen.body?.status === "pending" && stReopen.body?.resolvedAt === null,
    `status ${stReopen.status} ${JSON.stringify(stReopen.body?.resolvedAt)}`,
  );

  // Viewer cannot patch or add a message.
  const stPatchViewer = await req("PATCH", `${ST}/${stTicketId}`, {
    cookie: platformViewerCk,
    headers: HDR,
    json: { status: "closed" },
  });
  check("support tickets: viewer cannot patch (403)", stPatchViewer.status === 403, `status ${stPatchViewer.status}`);
  const stMsgViewer = await req("POST", `${ST}/${stTicketId}/messages`, {
    cookie: platformViewerCk,
    headers: HDR,
    json: { body: "sneaky" },
  });
  check("support tickets: viewer cannot add a message (403)", stMsgViewer.status === 403, `status ${stMsgViewer.status}`);

  // Unknown id → 404 on detail and on patch.
  const stMissing = await req("GET", `${ST}/nope-nope-nope`, { cookie: platformAdminCk });
  check("support tickets: unknown id detail → 404", stMissing.status === 404, `status ${stMissing.status}`);

  // Cross-org filter isolation: a second ticket for contoso must never surface
  // when the queue is filtered to acme, and vice-versa.
  const stContoso = await req("POST", ST, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { organizationId: contosoId, subject: "Contoso billing question", body: "Invoice mismatch." },
  });
  check("support tickets: admin creates a ticket for contoso (200)", stContoso.status === 200, `status ${stContoso.status}`);
  const stContosoId = stContoso.body?.id as string;

  const stFilterAcme = await req("GET", `${ST}?organizationId=${acmeId}`, { cookie: platformAdminCk });
  check(
    "support tickets: organizationId=acme filter shows acme's ticket, never contoso's",
    stFilterAcme.status === 200 &&
      (stFilterAcme.body?.items ?? []).some((t: any) => t.id === stTicketId) &&
      !(stFilterAcme.body?.items ?? []).some((t: any) => t.id === stContosoId),
    JSON.stringify((stFilterAcme.body?.items ?? []).map((t: any) => t.id)),
  );
  const stFilterContoso = await req("GET", `${ST}?organizationId=${contosoId}`, { cookie: platformAdminCk });
  check(
    "support tickets: organizationId=contoso filter shows contoso's ticket, never acme's",
    stFilterContoso.status === 200 &&
      (stFilterContoso.body?.items ?? []).some((t: any) => t.id === stContosoId) &&
      !(stFilterContoso.body?.items ?? []).some((t: any) => t.id === stTicketId),
    JSON.stringify((stFilterContoso.body?.items ?? []).map((t: any) => t.id)),
  );

  // Queue filter: critical view is priority-based, not status.
  const stCritical = await req("POST", ST, {
    cookie: platformAdminCk,
    headers: HDR,
    json: { organizationId: acmeId, subject: "urgent outage", priority: "critical", body: "down" },
  });
  const stQueueCritical = await req("GET", `${ST}?queue=critical`, { cookie: platformAdminCk });
  check(
    "support tickets: queue=critical filters by priority, includes the critical ticket",
    stQueueCritical.status === 200 &&
      (stQueueCritical.body?.items ?? []).some((t: any) => t.id === stCritical.body?.id) &&
      (stQueueCritical.body?.items ?? []).every((t: any) => t.priority === "critical"),
    JSON.stringify((stQueueCritical.body?.items ?? []).map((t: any) => t.priority)),
  );

  // ── W. System health (spec #17): readiness endpoint + observational admin surface. ──
  const readyRes = await fetch(`${base}/health/ready`);
  const readyBody = (await readyRes.json().catch(() => null)) as {
    ok?: boolean;
    database?: { status?: string };
  } | null;
  check(
    "/health/ready reports DB reachable (200 + ok:true + database status)",
    readyRes.status === 200 &&
      readyBody?.ok === true &&
      typeof readyBody?.database?.status === "string",
    `status ${readyRes.status} body=${JSON.stringify(readyBody)}`,
  );

  const shAdmin = await req("GET", "/rpc-admin/system-health", { cookie: platformAdminCk });
  const shComponents = (shAdmin.body?.components ?? []) as Array<{
    key: string;
    status: string;
    responseTimeMs: number | null;
  }>;
  check(
    "system-health: admin gets overall + a component list",
    shAdmin.status === 200 &&
      ["operational", "degraded", "down"].includes(shAdmin.body?.overall) &&
      Array.isArray(shAdmin.body?.components) &&
      shComponents.length > 0,
    `status ${shAdmin.status} overall=${shAdmin.body?.overall}`,
  );
  const dbComp = shComponents.find((c) => c.key === "database");
  check(
    "system-health: Database probe is real (operational + measured latency)",
    dbComp?.status === "operational" && typeof dbComp?.responseTimeMs === "number",
    JSON.stringify(dbComp),
  );
  const apiComp = shComponents.find((c) => c.key === "api");
  check(
    "system-health: API probe is operational",
    apiComp?.status === "operational",
    JSON.stringify(apiComp),
  );
  // Honesty assertion: billing is off in the offline e2e, so Payment must NOT
  // be a fabricated green — it reports not_configured. Cache is not_applicable.
  const payComp = shComponents.find((c) => c.key === "payment");
  check(
    "system-health: Payment is not_configured with billing off (never a fake green)",
    payComp?.status === "not_configured",
    JSON.stringify(payComp),
  );
  const cacheComp = shComponents.find((c) => c.key === "cache");
  check(
    "system-health: Cache is not_applicable (no such service in the scaffold)",
    cacheComp?.status === "not_applicable",
    JSON.stringify(cacheComp),
  );

  // Role gate: it is read-only, so every platform role (viewer included) reads it…
  const shViewer = await req("GET", "/rpc-admin/system-health", { cookie: platformViewerCk });
  check(
    "system-health: platform viewer may read (read-only surface)",
    shViewer.status === 200,
    `status ${shViewer.status}`,
  );
  // …but a non-platform actor (an ordinary tenant owner) is refused.
  const shOrdinary = await req("GET", "/rpc-admin/system-health", { cookie: ownerCk });
  check(
    "system-health: ordinary tenant owner blocked (403)",
    shOrdinary.status === 403,
    `status ${shOrdinary.status}`,
  );

  const shEvents = await req("GET", "/rpc-admin/system-health/events", { cookie: platformAdminCk });
  check(
    "system-health: recent events reads the real audit store (array of events)",
    shEvents.status === 200 && Array.isArray(shEvents.body?.events),
    `status ${shEvents.status}`,
  );
  const shEventsOrdinary = await req("GET", "/rpc-admin/system-health/events", { cookie: ownerCk });
  check(
    "system-health: events blocked for a non-platform actor (403)",
    shEventsOrdinary.status === 403,
    `status ${shEventsOrdinary.status}`,
  );

  // ── W0d. Platform admin: global customers (the platform-wide `customer`
  //     identity pool, /admin/global-customers). Proves the permission gate
  //     and the DB-level effect of each mutation directly (status column +
  //     session-count), the same shape agora-api's e2e uses — a full sign-in
  //     round trip through agora/customer-auth's own HTTP routes is a
  //     separate, not-yet-existing e2e concern for that module and is out of
  //     scope for this plan (see
  //     .ai/plans/agora/active/platform-admin-global-customers/README.md). ──
  {
    const { hashMemberPassword } = await import("agora/member-auth");
    const gcEmail = "e2e-global-customer@example.com";
    const [existingGc] = await adminDb
      .select({ id: schema.customer.id })
      .from(schema.customer)
      .where(eq(schema.customer.email, gcEmail))
      .limit(1);
    let gcId = existingGc?.id;
    if (!gcId) {
      const [created] = await adminDb
        .insert(schema.customer)
        .values({
          email: gcEmail,
          name: "E2E Global Customer",
          passwordHash: await hashMemberPassword(PW),
        })
        .returning({ id: schema.customer.id });
      gcId = created!.id;
    }
    await withTenant(acmeId, async (tx) => {
      const [existingLink] = await tx
        .select({ id: schema.tenantMember.id })
        .from(schema.tenantMember)
        .where(eq(schema.tenantMember.email, gcEmail))
        .limit(1);
      if (existingLink) return;
      await tx.insert(schema.tenantMember).values({
        tenantId: acmeId,
        email: gcEmail,
        name: "E2E Global Customer",
        passwordHash: `scrypt$${"00".repeat(16)}$${"00".repeat(64)}`,
        customerId: gcId,
        status: "active",
      });
    });

    const gcListAdmin = await req("GET", "/rpc-admin/global-customers?pageSize=100", {
      cookie: platformAdminCk,
    });
    check(
      "global-customers: admin list includes the seeded e2e global customer",
      gcListAdmin.status === 200 &&
        (gcListAdmin.body?.items ?? []).some((c: any) => c.id === gcId),
      JSON.stringify(gcListAdmin.body),
    );
    const gcListViewer = await req("GET", "/rpc-admin/global-customers?pageSize=100", {
      cookie: platformViewerCk,
    });
    check(
      "global-customers: platform viewer may read (read-only floor)",
      gcListViewer.status === 200,
      `status ${gcListViewer.status}`,
    );
    const gcListOrdinary = await req("GET", "/rpc-admin/global-customers", { cookie: ownerCk });
    check(
      "global-customers: ordinary tenant owner blocked (403)",
      gcListOrdinary.status === 403,
      `status ${gcListOrdinary.status}`,
    );

    const gcDetail = await req("GET", `/rpc-admin/global-customers/${gcId}`, {
      cookie: platformAdminCk,
    });
    check(
      "global-customers: detail shows the linked tenant membership",
      gcDetail.status === 200 &&
        gcDetail.body?.memberships?.length === 1 &&
        gcDetail.body?.memberships?.[0]?.tenantId === acmeId,
      JSON.stringify(gcDetail.body),
    );

    const gcSuspendAsViewer = await req(
      "POST",
      `/rpc-admin/global-customers/${gcId}/suspend`,
      { cookie: platformViewerCk, headers: HDR },
    );
    check(
      "global-customers: platform viewer cannot suspend (403)",
      gcSuspendAsViewer.status === 403,
      `status ${gcSuspendAsViewer.status}`,
    );

    const gcSuspend = await req("POST", `/rpc-admin/global-customers/${gcId}/suspend`, {
      cookie: platformAdminCk,
      headers: HDR,
    });
    check(
      "global-customers: platform admin can suspend",
      gcSuspend.status === 200 && gcSuspend.body?.ok === true,
      JSON.stringify(gcSuspend.body),
    );

    const [suspendedRow] = await adminDb
      .select({ status: schema.customer.status })
      .from(schema.customer)
      .where(eq(schema.customer.id, gcId))
      .limit(1);
    check(
      "global-customers: suspend sets customer.status = 'suspended'",
      suspendedRow?.status === "suspended",
      JSON.stringify(suspendedRow),
    );

    const sessionsAfterSuspend = await adminDb
      .select({ id: schema.customerSession.id })
      .from(schema.customerSession)
      .where(eq(schema.customerSession.customerId, gcId));
    check(
      "global-customers: suspend revokes every active session",
      sessionsAfterSuspend.length === 0,
      `remaining sessions ${sessionsAfterSuspend.length}`,
    );

    const gcReactivate = await req(
      "POST",
      `/rpc-admin/global-customers/${gcId}/reactivate`,
      { cookie: platformAdminCk, headers: HDR },
    );
    check(
      "global-customers: platform admin can reactivate",
      gcReactivate.status === 200 && gcReactivate.body?.ok === true,
      JSON.stringify(gcReactivate.body),
    );
    const [reactivatedRow] = await adminDb
      .select({ status: schema.customer.status })
      .from(schema.customer)
      .where(eq(schema.customer.id, gcId))
      .limit(1);
    check(
      "global-customers: reactivate sets customer.status = 'active'",
      reactivatedRow?.status === "active",
      JSON.stringify(reactivatedRow),
    );

    const gcAuditRows = await adminDb
      .select({ action: platformAuditEvent.action })
      .from(platformAuditEvent)
      .where(eq(platformAuditEvent.targetId, gcId));
    check(
      "global-customers: suspend + reactivate each wrote one platform audit row",
      gcAuditRows.filter((r) => r.action === "platform_global_customer.suspend").length ===
        1 &&
        gcAuditRows.filter((r) => r.action === "platform_global_customer.reactivate")
          .length === 1,
      JSON.stringify(gcAuditRows),
    );

    const gcRevokeAsViewer = await req(
      "POST",
      `/rpc-admin/global-customers/${gcId}/revoke-sessions`,
      { cookie: platformViewerCk, headers: HDR },
    );
    check(
      "global-customers: platform viewer cannot revoke sessions (403)",
      gcRevokeAsViewer.status === 403,
      `status ${gcRevokeAsViewer.status}`,
    );
    const gcRevoke = await req(
      "POST",
      `/rpc-admin/global-customers/${gcId}/revoke-sessions`,
      { cookie: platformAdminCk, headers: HDR },
    );
    check(
      "global-customers: platform admin can revoke sessions",
      gcRevoke.status === 200 && gcRevoke.body?.ok === true,
      JSON.stringify(gcRevoke.body),
    );

    const gcResetAsViewer = await req(
      "POST",
      `/rpc-admin/global-customers/${gcId}/send-password-reset`,
      { cookie: platformViewerCk, headers: HDR },
    );
    check(
      "global-customers: platform viewer cannot send a password reset (403)",
      gcResetAsViewer.status === 403,
      `status ${gcResetAsViewer.status}`,
    );
    const gcReset = await req(
      "POST",
      `/rpc-admin/global-customers/${gcId}/send-password-reset`,
      { cookie: platformAdminCk, headers: HDR },
    );
    check(
      "global-customers: platform admin can trigger a password reset",
      gcReset.status === 200 && gcReset.body?.ok === true,
      JSON.stringify(gcReset.body),
    );

    const gcNotFound = await req(
      "POST",
      "/rpc-admin/global-customers/does-not-exist/suspend",
      { cookie: platformAdminCk, headers: HDR },
    );
    check(
      "global-customers: suspend 404s for an unknown customer id",
      gcNotFound.status === 404,
      `status ${gcNotFound.status}`,
    );
  }

  // ── W0e. PayMongo synthetic webhook — end-to-end through the real app.ts route. ──
  {
    process.env.PAYMONGO_WEBHOOK_SECRET = "whsec_e2e_paymongo";
    process.env.BILLING_PROVIDER = "paymongo";

    // Shape matches the real envelope empirically captured against a live PayMongo
    // test account (see .ai/plans/agora/active/paymongo-billing-driver/README.md,
    // Precondition A) — the payment resource's own `id` lives on `data.id` (a
    // sibling of `attributes`, not nested inside it), which is what
    // parsePaymongoTransactionEvent reads as providerObjectId.
    const evt = {
      data: {
        id: "evt_LBSDkif3tKTJ95zr68bBEQGc",
        type: "event",
        attributes: {
          type: "payment.paid",
          livemode: false,
          data: {
            id: "pay_LBSDkif3tKTJ95zr68bBEQGc",
            type: "payment",
            attributes: {
              amount: 500000,
              currency: "PHP",
              status: "paid",
              metadata: { tenantId: acmeId, plan: "pro" },
            },
          },
        },
      },
    };
    const evtPayload = JSON.stringify(evt);
    const t = Math.floor(Date.now() / 1000);
    const te = createHmac("sha256", "whsec_e2e_paymongo")
      .update(`${t}.${evtPayload}`)
      .digest("hex");
    const header = `t=${t},te=${te},li=`;

    const res = await fetch(`${base}/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "paymongo-signature": header },
      body: evtPayload,
    });
    check("txn: synthetic paymongo webhook accepted (200)", res.status === 200);

    const pmRow = await withTenant(acmeId, (tx) =>
      tx
        .select()
        .from(paymentTransaction)
        .where(eq(paymentTransaction.providerObjectId, "pay_LBSDkif3tKTJ95zr68bBEQGc")),
    );
    check(
      "txn: paymongo webhook actually created a payment_transaction row (not just 200)",
      pmRow.length === 1 &&
        pmRow[0]?.paymentProvider === "paymongo" &&
        pmRow[0]?.kind === "charge" &&
        pmRow[0]?.amount === "500000",
      JSON.stringify(pmRow[0]),
    );

    const badHeader = `t=${t},te=bad,li=`;
    const resBad = await fetch(`${base}/billing/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "paymongo-signature": badHeader },
      body: evtPayload,
    });
    check("txn: synthetic paymongo webhook tampered rejected (400)", resBad.status === 400);

    // cleanup
    __setBillingProvider(null);
    delete process.env.PAYMONGO_WEBHOOK_SECRET;
    delete process.env.BILLING_PROVIDER;
  }

  // ── W0f. Stripe checkout route wiring (unified-billing-price-source Phase 3) —
  // confirms the route actually resolves + passes amountMinorUnits/resolvedCurrency
  // to the provider, not just that checkoutAmountFor's own unit tests pass in
  // isolation (test:billing-pricing covers the pure resolver; this covers the glue). ──
  {
    process.env.STRIPE_SECRET_KEY = "sk_test_e2e_pricing";
    // The e2e harness seeds `plan` rows directly (never runs the real
    // migration's plan_price backfill SQL) — seed one plan_price row for
    // "pro" ourselves, matching unified-billing-price-source Phase 6's own
    // documented caveat ("any new e2e that drives a real checkout must seed
    // plan_price rows before the assertion").
    const [proPlanRow] = await adminDb
      .select({ id: schema.plan.id })
      .from(schema.plan)
      .where(eq(schema.plan.key, "pro"))
      .limit(1);
    if (proPlanRow) {
      await adminDb
        .insert(schema.planPrice)
        .values({
          id: createId(),
          planId: proPlanRow.id,
          currency: "usd",
          monthlyPrice: "49.00",
          annualPrice: "490.00",
        })
        .onConflictDoNothing();
    }
    let receivedAmount: number | undefined;
    let receivedCurrency: string | undefined;
    __setBillingProvider({
      async createCheckoutSession(params: any) {
        receivedAmount = params.amountMinorUnits;
        receivedCurrency = params.resolvedCurrency;
        return { url: "https://checkout.stripe.test/cs_e2e", customerId: null };
      },
      async createPortalSession() {
        throw new Error("not used in this test");
      },
    });
    const stripeCheckout = await req("POST", "/rpc/billing/checkout", {
      slug: "acme",
      cookie: ownerCk,
      json: { plan: "pro" },
    });
    check(
      "checkout: Stripe route resolves + passes amountMinorUnits/resolvedCurrency to the provider",
      stripeCheckout.status === 200 &&
        typeof receivedAmount === "number" &&
        receivedAmount > 0 &&
        receivedCurrency === "usd", // acme has no organization.timezone set -> falls
        // through to the platform default, which defaults to "usd" with no override.
      `status ${stripeCheckout.status} amount=${receivedAmount} currency=${receivedCurrency} body=${JSON.stringify(stripeCheckout.body)}`,
    );

    // cleanup
    __setBillingProvider(null);
    delete process.env.STRIPE_SECRET_KEY;
  }

  // ── W0g. Xendit checkout: refuses when no plan_price row exists for the
  // resolved currency (remove-billing-env-price-fallback — there is no more
  // env-var fallback; a resolver refusal is now a hard 409). ──
  {
    process.env.BILLING_PROVIDER = "xendit";
    process.env.XENDIT_SECRET_KEY = "xnd_test_e2e";
    // Deliberately do NOT seed a plan_price row in a Xendit-supported currency
    // (idr/php) for "pro" — W0f only seeded one in "usd", which
    // providerSupportedCurrencies() excludes for Xendit — so
    // resolveCheckoutCurrency refuses and the checkout must now hard-fail.
    let receivedAmount: number | undefined;
    let receivedCurrency: string | undefined;
    __setBillingProvider({
      async createCheckoutSession(params: any) {
        receivedAmount = params.amountMinorUnits;
        receivedCurrency = params.resolvedCurrency;
        return { url: "https://checkout.xendit.test/inv_e2e", customerId: null };
      },
      async createPortalSession() {
        throw new Error("not used in this test");
      },
    });
    const xenditCheckout = await req("POST", "/rpc/billing/checkout", {
      slug: "acme",
      cookie: ownerCk,
      json: { plan: "pro" },
    });
    check(
      "checkout: Xendit refuses (409) with no priced currency available, never calls the provider",
      xenditCheckout.status === 409 &&
        typeof xenditCheckout.body?.error === "string" &&
        xenditCheckout.body.error.includes("No priced currency is available") &&
        receivedAmount === undefined &&
        receivedCurrency === undefined,
      `status ${xenditCheckout.status} amount=${receivedAmount} currency=${receivedCurrency} body=${JSON.stringify(xenditCheckout.body)}`,
    );

    // cleanup
    __setBillingProvider(null);
    delete process.env.XENDIT_SECRET_KEY;
    delete process.env.BILLING_PROVIDER;
  }

  // ── Y. App-usage (app-usage plan, Phase 5): device pairing → ingest →
  //     the three staff-facing reads (permission gate) → cross-tenant
  //     isolation. ──
  {
    const { chronoBranch } = await import("../modules/branch/schema");
    const { chronoDevice } = await import("../modules/device/schema");
    const { chronoAppUsageEvent } = await import("../modules/app-usage/schema");

    const [appUsageBranch] = await withTenant(acmeId, (tx) =>
      tx
        .insert(chronoBranch)
        .values({ id: createId(), tenantId: acmeId, name: "App Usage Branch", code: "AUB" })
        .returning(),
    );

    // Pair + approve a device WITH a station assigned.
    const tokenRes = await req("POST", "/rpc/devices/provisioning-tokens", {
      slug: "acme",
      cookie: ownerCk,
      json: { branchId: appUsageBranch!.id, name: "App Usage Kiosk", pairingCodeTtlMinutes: 30, maxUses: 1 },
    });
    check("app-usage: provisioning token created", tokenRes.status === 201, JSON.stringify(tokenRes.body));
    const pairingCode = tokenRes.body?.provisioningToken?.pairingCode as string;
    const pairRes = await req("POST", "/api/v1/device/pair", { json: { pairingCode } });
    const fingerprint = "e2e-app-usage-fp";
    const authRes = await req("POST", "/api/v1/device/auth", {
      json: { provisioningToken: pairRes.body?.provisioningToken, fingerprint, hostname: "app-usage-kiosk" },
    });
    const deviceToken = authRes.body?.deviceToken as string;
    check("app-usage: device auth mints a token", typeof deviceToken === "string" && deviceToken.length > 0);

    const devicesList = await req("GET", "/rpc/devices?page=1&pageSize=10", { slug: "acme", cookie: ownerCk });
    const deviceId = (devicesList.body?.items ?? []).find((d: any) => d.hostname === "app-usage-kiosk")?.id as string;
    const approveRes = await req("POST", `/rpc/devices/${deviceId}/approve`, {
      slug: "acme",
      cookie: ownerCk,
      json: { newStationName: "App Usage Station", newStationNumber: "AU-01" },
    });
    check("app-usage: device approved with a station", approveRes.status === 200, JSON.stringify(approveRes.body));
    const stationId = approveRes.body?.device?.stationId as string;

    // A device with NO assigned station gets 409 — approve always assigns
    // one via the API, so a second device is approved then has its
    // stationId nulled directly (the same state a station deletion's
    // onDelete: "set null" would leave behind), mirroring the module's own
    // ingest.test.ts.
    const tokenRes2 = await req("POST", "/rpc/devices/provisioning-tokens", {
      slug: "acme",
      cookie: ownerCk,
      json: { branchId: appUsageBranch!.id, name: "App Usage Kiosk 2", pairingCodeTtlMinutes: 30, maxUses: 1 },
    });
    const pairRes2 = await req("POST", "/api/v1/device/pair", {
      json: { pairingCode: tokenRes2.body?.provisioningToken?.pairingCode },
    });
    const fingerprint2 = "e2e-app-usage-fp-2";
    const authRes2 = await req("POST", "/api/v1/device/auth", {
      json: { provisioningToken: pairRes2.body?.provisioningToken, fingerprint: fingerprint2, hostname: "app-usage-kiosk-2" },
    });
    const noStationDeviceToken = authRes2.body?.deviceToken as string;
    const devicesList2 = await req("GET", "/rpc/devices?page=1&pageSize=10", { slug: "acme", cookie: ownerCk });
    const deviceId2 = (devicesList2.body?.items ?? []).find((d: any) => d.hostname === "app-usage-kiosk-2")?.id as string;
    await req("POST", `/rpc/devices/${deviceId2}/approve`, {
      slug: "acme",
      cookie: ownerCk,
      json: { newStationName: "App Usage Station 2", newStationNumber: "AU-02" },
    });
    await withTenant(acmeId, (tx) =>
      tx.update(chronoDevice).set({ stationId: null }).where(eq(chronoDevice.id, deviceId2)),
    );
    const noStationRes = await req("POST", "/api/v1/device/app-usage/events", {
      bearer: noStationDeviceToken,
      headers: { "x-device-fingerprint": fingerprint2 },
      json: { launched: [], closed: [] },
    });
    check("app-usage: device with no station -> 409", noStationRes.status === 409, `status ${noStationRes.status}`);

    // Happy path: launched then closed for the same runId.
    const now = new Date();
    const startedAt = new Date(now.getTime() - 60_000).toISOString();
    const endedAt = now.toISOString();
    const launchRes = await req("POST", "/api/v1/device/app-usage/events", {
      bearer: deviceToken,
      headers: { "x-device-fingerprint": fingerprint },
      json: { launched: [{ runId: "e2e-run-1", category: "game", appName: "E2E Game", startedAt }], closed: [] },
    });
    check(
      "app-usage: launched accepted",
      launchRes.status === 201 && launchRes.body?.launchedAccepted === 1,
      JSON.stringify(launchRes.body),
    );
    const closeRes = await req("POST", "/api/v1/device/app-usage/events", {
      bearer: deviceToken,
      headers: { "x-device-fingerprint": fingerprint },
      json: { launched: [], closed: [{ runId: "e2e-run-1", endedAt }] },
    });
    check(
      "app-usage: closed applied",
      closeRes.status === 201 && closeRes.body?.closedApplied === 1,
      JSON.stringify(closeRes.body),
    );

    const [row] = await withTenant(acmeId, (tx) =>
      tx.select().from(chronoAppUsageEvent).where(eq(chronoAppUsageEvent.runId, "e2e-run-1")),
    );
    check(
      "app-usage: row lands with the DEVICE-REPORTED timestamps, not server-receive time",
      row?.startedAt?.toISOString() === startedAt && row?.endedAt?.toISOString() === endedAt,
      JSON.stringify({ got: { startedAt: row?.startedAt, endedAt: row?.endedAt }, want: { startedAt, endedAt } }),
    );

    // Staff-facing reads — happy path (owner holds appUsage:read).
    const currentRes = await req("GET", `/rpc/app-usage/current?stationId=${stationId}`, {
      slug: "acme",
      cookie: ownerCk,
    });
    check(
      "app-usage: GET /current 200, returns the open station's rows",
      currentRes.status === 200 && (currentRes.body?.items?.length ?? 0) >= 1,
      JSON.stringify(currentRes.body),
    );
    const listRes = await req("GET", "/rpc/app-usage?page=1&pageSize=10", { slug: "acme", cookie: ownerCk });
    check(
      "app-usage: GET / 200, paginated history includes the posted run",
      listRes.status === 200 && (listRes.body?.items ?? []).some((r: any) => r.runId === "e2e-run-1"),
      JSON.stringify(listRes.body),
    );
    const from = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const summaryQs = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&page=1&pageSize=10`;
    const summaryRes = await req("GET", `/rpc/app-usage/summary?${summaryQs}`, { slug: "acme", cookie: ownerCk });
    check(
      "app-usage: GET /summary 200, aggregates the closed app",
      summaryRes.status === 200 &&
        (summaryRes.body?.items ?? []).some(
          (r: any) => r.appName === "E2E Game" && r.category === "game",
        ),
      JSON.stringify(summaryRes.body),
    );

    // Permission gate: appUsage:read is a single-tier gate — every system
    // role holds it, so there's no staff-vs-admin split to assert (unlike
    // most other resources). Assign acmeStaff a custom role granting NOTHING
    // to prove the real gate, mirroring the T1c section's own
    // create-role→assign→revert convention.
    const noGrantRole = await req("POST", "/rpc/roles", {
      slug: "acme",
      cookie: ownerCk,
      json: { key: "no-app-usage", name: "No App Usage", permissions: {} },
    });
    check("app-usage: no-grant custom role created", noGrantRole.status === 201, JSON.stringify(noGrantRole.body));
    await adminDb
      .update(schema.member)
      .set({ role: "no-app-usage" })
      .where(and(eq(schema.member.organizationId, acmeId), eq(schema.member.userId, acmeStaff)));

    const currentDenied = await req("GET", `/rpc/app-usage/current?stationId=${stationId}`, {
      slug: "acme",
      cookie: staffCk,
    });
    check(
      "app-usage: GET /current 403 without appUsage:read",
      currentDenied.status === 403,
      `status ${currentDenied.status}`,
    );
    const listDenied = await req("GET", "/rpc/app-usage?page=1&pageSize=10", { slug: "acme", cookie: staffCk });
    check(
      "app-usage: GET / 403 without appUsage:read",
      listDenied.status === 403,
      `status ${listDenied.status}`,
    );
    const summaryDenied = await req("GET", `/rpc/app-usage/summary?${summaryQs}`, {
      slug: "acme",
      cookie: staffCk,
    });
    check(
      "app-usage: GET /summary 403 without appUsage:read",
      summaryDenied.status === 403,
      `status ${summaryDenied.status}`,
    );

    // Revert acmeStaff to "staff" and remove the throwaway role — same
    // cleanup convention T1c's own custom-role section follows.
    await adminDb
      .update(schema.member)
      .set({ role: "staff" })
      .where(and(eq(schema.member.organizationId, acmeId), eq(schema.member.userId, acmeStaff)));
    await req("DELETE", "/rpc/roles/no-app-usage", { slug: "acme", cookie: ownerCk });

    // Cross-tenant isolation: contoso's owner never sees acme's device-posted rows.
    const contosoCurrent = await req("GET", `/rpc/app-usage/current?stationId=${stationId}`, {
      slug: "contoso",
      cookie: contosoOwnerCk,
    });
    check(
      "app-usage: cross-tenant current returns empty, not acme's row",
      contosoCurrent.status === 200 && (contosoCurrent.body?.items?.length ?? 0) === 0,
      JSON.stringify(contosoCurrent.body),
    );
    const contosoList = await req("GET", "/rpc/app-usage?page=1&pageSize=10", {
      slug: "contoso",
      cookie: contosoOwnerCk,
    });
    check(
      "app-usage: cross-tenant list never contains acme's runId",
      contosoList.status === 200 && !(contosoList.body?.items ?? []).some((r: any) => r.runId === "e2e-run-1"),
      JSON.stringify(contosoList.body),
    );
    const contosoSummary = await req("GET", `/rpc/app-usage/summary?${summaryQs}`, {
      slug: "contoso",
      cookie: contosoOwnerCk,
    });
    check(
      "app-usage: cross-tenant summary never contains acme's app",
      contosoSummary.status === 200 &&
        !(contosoSummary.body?.items ?? []).some((r: any) => r.appName === "E2E Game"),
      JSON.stringify(contosoSummary.body),
    );
  }

  // ── X. Hard delete acme; contoso must remain fully intact (runs LAST). ──
  const delStaff = await req("POST", "/rpc/tenant/delete", {
    slug: "acme",
    cookie: staffCk,
    json: { confirmSlug: "acme" },
  });
  check("non-owner blocked from delete (403)", delStaff.status === 403, `status ${delStaff.status}`);

  const delWrong = await req("POST", "/rpc/tenant/delete", {
    slug: "acme",
    cookie: ownerCk,
    json: { confirmSlug: "not-acme" },
  });
  check("wrong confirm slug rejected (400)", delWrong.status === 400, `status ${delWrong.status}`);

  const delOk = await req("POST", "/rpc/tenant/delete", {
    slug: "acme",
    cookie: ownerCk,
    json: { confirmSlug: "acme" },
  });
  check("owner deletes business (200)", delOk.status === 200, `status ${delOk.status}`);

  const acmeOrgAfter = await adminDb
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.id, acmeId));
  check("acme organization row removed", acmeOrgAfter.length === 0, `got ${acmeOrgAfter.length}`);

  const acmeProjectsAfter = await withTenant(acmeId, (tx) => tx.select().from(project));
  check("acme tenant-scoped rows cascade-deleted", acmeProjectsAfter.length === 0, `got ${acmeProjectsAfter.length}`);

  const contosoOrgAfter = await adminDb
    .select()
    .from(schema.organization)
    .where(eq(schema.organization.id, contosoId));
  check("contoso organization intact after acme delete", contosoOrgAfter.length === 1, `got ${contosoOrgAfter.length}`);

  const contosoProjectsAfter = await withTenant(contosoId, (tx) => tx.select().from(project));
  check(
    "contoso projects intact after acme delete",
    contosoProjectsAfter.length >= 1 && contosoProjectsAfter.every((p) => p.tenantId === contosoId),
    `got ${contosoProjectsAfter.length}`,
  );

  const acmeOwnerUserAfter = await adminDb
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, "owner@acme.test"));
  check(
    "orphaned acme owner user deleted (no other org)",
    acmeOwnerUserAfter.length === 0,
    `got ${acmeOwnerUserAfter.length}`,
  );

  // ── Data retention sweep (.ai/plans/agora/active/data-retention/README.md) ──
  const { runRetentionSweepOnce } = await import("agora/server");
  const daysAgoDate = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Job pruning: terminal rows past the (default) 30-day window are deleted;
  // recent ones and pending rows within the window survive.
  const [oldSuccessJob, recentFailedJob] = await withAdmin((tx) =>
    tx
      .insert(job)
      .values([
        {
          id: createId(),
          queue: "email",
          type: "send-email",
          status: "success",
          attempts: 1,
          maxAttempts: 6,
          payload: {},
          updatedAt: daysAgoDate(31),
        },
        {
          id: createId(),
          queue: "email",
          type: "send-email",
          status: "failed",
          attempts: 6,
          maxAttempts: 6,
          payload: {},
          updatedAt: daysAgoDate(5),
        },
      ])
      .returning(),
  );
  // Backdate createdAt too (updatedAt alone isn't enough for the pending case
  // below, which prunes on createdAt) — a second update since `.insert` always
  // sets createdAt server-side to now().
  await withAdmin((tx) =>
    tx.update(job).set({ updatedAt: daysAgoDate(31) }).where(eq(job.id, oldSuccessJob!.id)),
  );
  const [oldPendingJob, recentPendingJob] = await withAdmin((tx) =>
    tx
      .insert(job)
      .values([
        {
          id: createId(),
          queue: "webhooks",
          type: "deliver-webhook",
          status: "pending",
          attempts: 1,
          maxAttempts: 6,
          payload: {},
        },
        {
          id: createId(),
          queue: "webhooks",
          type: "deliver-webhook",
          status: "pending",
          attempts: 1,
          maxAttempts: 6,
          payload: {},
        },
      ])
      .returning(),
  );
  await withAdmin((tx) =>
    tx
      .update(job)
      .set({ createdAt: daysAgoDate(91) })
      .where(eq(job.id, oldPendingJob!.id)),
  );

  const [oldPlatformAuditRow] = await withAdmin((tx) =>
    tx
      .insert(platformAuditEvent)
      .values({
        id: createId(),
        actorId: null,
        action: "e2e.retention.probe",
        metadata: {},
      })
      .returning(),
  );
  await withAdmin((tx) =>
    tx
      .update(platformAuditEvent)
      .set({ createdAt: daysAgoDate(366) })
      .where(eq(platformAuditEvent.id, oldPlatformAuditRow!.id)),
  );

  // Tenant audit_event pruning uses contoso's OWN current plan's live
  // retention (queried fresh, not assumed — earlier sections in this suite
  // may have changed it) so this stays correct regardless of test order.
  const [contosoSubForRetention] = await withTenant(contosoId, (tx) =>
    tx.select({ plan: tenantSubscription.plan }).from(tenantSubscription),
  );
  const contosoPlanKey = contosoSubForRetention?.plan ?? "free";
  const contosoRetentionRes = await req("GET", "/rpc/billing", {
    slug: "contoso",
    cookie: contosoOwnerCk,
  });
  const contosoRetentionDays: number =
    contosoRetentionRes.body?.entitlements?.auditRetentionDays ?? 7;
  const [oldAuditRow, recentAuditRow] = await withTenant(contosoId, (tx) =>
    tx
      .insert(auditEvent)
      .values([
        {
          id: createId(),
          tenantId: contosoId,
          actorType: "system",
          action: "e2e.retention.probe",
        },
        {
          id: createId(),
          tenantId: contosoId,
          actorType: "system",
          action: "e2e.retention.probe",
        },
      ])
      .returning(),
  );
  await withAdmin((tx) =>
    tx
      .update(auditEvent)
      .set({ createdAt: daysAgoDate(contosoRetentionDays + 1) })
      .where(eq(auditEvent.id, oldAuditRow!.id)),
  );

  const sweepResult = await runRetentionSweepOnce();
  check(
    "retention sweep ran and reports non-negative counts",
    sweepResult.jobDeleted >= 0 &&
      sweepResult.auditDeleted >= 0 &&
      sweepResult.platformAuditDeleted >= 0,
    JSON.stringify(sweepResult),
  );

  const [oldSuccessJobAfter, recentFailedJobAfter] = await withAdmin((tx) =>
    tx
      .select()
      .from(job)
      .where(inArray(job.id, [oldSuccessJob!.id, recentFailedJob!.id])),
  ).then((rows) => [
    rows.find((r) => r.id === oldSuccessJob!.id),
    rows.find((r) => r.id === recentFailedJob!.id),
  ]);
  check(
    "retention sweep deletes a terminal job past the retention window",
    oldSuccessJobAfter === undefined,
    JSON.stringify(oldSuccessJobAfter),
  );
  check(
    "retention sweep leaves a recent terminal job untouched",
    recentFailedJobAfter !== undefined,
    JSON.stringify(recentFailedJobAfter),
  );

  const [oldPendingAfter, recentPendingAfter] = await withAdmin((tx) =>
    tx
      .select()
      .from(job)
      .where(inArray(job.id, [oldPendingJob!.id, recentPendingJob!.id])),
  ).then((rows) => [
    rows.find((r) => r.id === oldPendingJob!.id),
    rows.find((r) => r.id === recentPendingJob!.id),
  ]);
  check(
    "retention sweep deletes a pending job past the stuck-job safety-net window",
    oldPendingAfter === undefined,
    JSON.stringify(oldPendingAfter),
  );
  check(
    "retention sweep leaves a recent pending job untouched",
    recentPendingAfter !== undefined,
    JSON.stringify(recentPendingAfter),
  );

  const platformAuditAfter = await withAdmin((tx) =>
    tx
      .select()
      .from(platformAuditEvent)
      .where(eq(platformAuditEvent.id, oldPlatformAuditRow!.id)),
  );
  check(
    "retention sweep deletes a platform audit event past retention",
    platformAuditAfter.length === 0,
    `got ${platformAuditAfter.length}`,
  );

  const [oldAuditAfter, recentAuditAfter] = await withAdmin((tx) =>
    tx
      .select()
      .from(auditEvent)
      .where(inArray(auditEvent.id, [oldAuditRow!.id, recentAuditRow!.id])),
  ).then((rows) => [
    rows.find((r) => r.id === oldAuditRow!.id),
    rows.find((r) => r.id === recentAuditRow!.id),
  ]);
  check(
    `retention sweep deletes a tenant audit event past its plan's (${contosoPlanKey}, ${contosoRetentionDays}d) retention`,
    oldAuditAfter === undefined,
    JSON.stringify(oldAuditAfter),
  );
  check(
    "retention sweep leaves a recent tenant audit event untouched",
    recentAuditAfter !== undefined,
    JSON.stringify(recentAuditAfter),
  );

  // ── Member portal social login (chrono/portal-social-login plan, Phase 6) ──
  // Re-runs the foundation's own member-oauth.test.ts case list
  // (create/reuse/cross-tenant/collision-refuse/suspended/unavailable/
  // missing-email/cancelled) against THIS app's database — a shared package's
  // guarantee (TenantMemberOAuthAccounts' unique indexes, the RLS policy
  // generated for it, this app's own tenant fixtures) is only real once each
  // consuming app proves it locally, same reasoning as `rls:proof` itself
  // (.ai/rules/database.md). Google is already configured for this whole
  // suite (see the env block near the top of main()); Facebook is
  // deliberately left unconfigured throughout, which doubles as this block's
  // provider-unavailable case — no env mutation needed for either.
  {
    // Dedicated tenants for this block — NOT the shared acmeId/contosoId
    // fixtures used elsewhere in this file: by this point in the run, acme
    // has already been through (and one later section hard-deletes) several
    // destructive lifecycle tests, so reusing it here would make these
    // assertions depend on file ordering. Two fresh, disposable orgs keep
    // this block self-contained.
    const oauthAcmeId = await ensureOrg("oauth-acme", "OAuth Acme");
    const oauthContosoId = await ensureOrg("oauth-contoso", "OAuth Contoso");
    const realFetch = globalThis.fetch;
    let googleSub = "chrono-google-sub-1";
    let googleEmail = "newplayer@example.com";
    // Implicit linking only ever applies to google + a verified email
    // (packages/agora/src/identity/member-auth/index.ts's callback handler) —
    // false is what drives the collision case into account_not_linked below,
    // without needing to enable Facebook (left deliberately unconfigured for
    // this whole suite) or wait out resolveAuthProviders()'s 5s cache.
    let googleEmailVerified = true;

    function fakeIdToken(claims: Record<string, unknown>): string {
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
    }

    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = String(input);
      if (url.startsWith(base)) return realFetch(input, init);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            id_token: fakeIdToken({
              iss: "https://accounts.google.com",
              aud: "e2e-google-client-id",
              sub: googleSub,
              email: googleEmail,
              email_verified: googleEmailVerified,
              name: "New Player",
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch in member OAuth e2e: ${url}`);
    }) as typeof fetch;

    try {
      // A pre-existing password member on acme, for the collision case.
      await withTenant(oauthAcmeId, (tx) =>
        tx.insert(schema.tenantMember).values({
          tenantId: oauthAcmeId,
          email: "existing-oauth@acme.test",
          name: "Existing OAuth Member",
          passwordHash: "scrypt$deadbeef$deadbeef",
        }),
      );
      // A suspended member with a linked google account, for the suspended case.
      const [suspendedMember] = await withTenant(oauthAcmeId, (tx) =>
        tx
          .insert(schema.tenantMember)
          .values({
            tenantId: oauthAcmeId,
            email: "suspended-oauth@acme.test",
            name: "Suspended OAuth Member",
            passwordHash: null,
            status: "suspended",
          })
          .returning({ id: schema.tenantMember.id }),
      );
      await withTenant(oauthAcmeId, (tx) =>
        tx.insert(schema.tenantMemberOAuthAccount).values({
          tenantId: oauthAcmeId,
          memberId: suspendedMember!.id,
          provider: "google",
          providerAccountId: "chrono-google-suspended-1",
          email: "suspended-oauth@acme.test",
        }),
      );

      // ── provider-unavailable: facebook has no credentials in this suite ──
      const fbUnavailable = await reqNoFollow("GET", "/portal/auth/facebook/start?tenant=oauth-acme");
      check("member oauth: facebook /start 404s while unconfigured", fbUnavailable.status === 404);

      async function driveMemberOAuth(
        tenantSlug: string,
        opts: { simulateCancel?: boolean } = {},
      ): Promise<NoFollowRes> {
        const start = await reqNoFollow("GET", `/portal/auth/google/start?tenant=${tenantSlug}`);
        if (start.status !== 302) {
          throw new Error(`member oauth /start did not redirect: ${start.status}`);
        }
        const cookie = jar(start.setCookie);
        const authorizeUrl = new URL(start.location!);
        const state = authorizeUrl.searchParams.get("state")!;
        const cb = opts.simulateCancel
          ? `/portal/auth/google/callback?state=${encodeURIComponent(state)}&error=access_denied`
          : `/portal/auth/google/callback?code=test-code&state=${encodeURIComponent(state)}`;
        return reqNoFollow("GET", cb, { cookie });
      }

      // ── create-on-first-login ──
      const memberFirst = await driveMemberOAuth("oauth-acme");
      check(
        "member oauth: google create-on-first-login redirects to /portal",
        memberFirst.location?.includes("/portal") ?? false,
        memberFirst.location ?? "",
      );
      const acmeMembersAfterFirst = await withTenant(oauthAcmeId, (tx) => tx.select().from(schema.tenantMember));
      const createdMember = acmeMembersAfterFirst.find((m) => m.email === googleEmail);
      check("member oauth: create-on-first-login inserted exactly one TenantMembers row", !!createdMember);
      check(
        "member oauth: created member has passwordHash null (OAuth-only)",
        createdMember?.passwordHash === null,
      );

      // ── reuse-on-second-login: same providerAccountId, no duplicate member ──
      const memberSecond = await driveMemberOAuth("oauth-acme");
      check(
        "member oauth: reuse-on-second-login redirects to /portal",
        memberSecond.location?.includes("/portal") ?? false,
      );
      const acmeMembersAfterSecond = await withTenant(oauthAcmeId, (tx) => tx.select().from(schema.tenantMember));
      check(
        "member oauth: no duplicate TenantMembers row on second login (tenant_member_email_uq holds)",
        acmeMembersAfterSecond.filter((m) => m.email === googleEmail).length === 1,
      );

      // ── cross-tenant separation: same providerAccountId, two tenants ──
      const memberCrossTenant = await driveMemberOAuth("oauth-contoso");
      check(
        "member oauth: cross-tenant login redirects to /portal",
        memberCrossTenant.location?.includes("/portal") ?? false,
      );
      const contosoMembersAfter = await withTenant(oauthContosoId, (tx) => tx.select().from(schema.tenantMember));
      const contosoCreatedMember = contosoMembersAfter.find((m) => m.email === googleEmail);
      check("member oauth: cross-tenant login created a SEPARATE member row in contoso", !!contosoCreatedMember);
      check(
        "member oauth: cross-tenant member id differs from acme's",
        !!contosoCreatedMember && contosoCreatedMember.id !== createdMember?.id,
      );

      // ── email-collision refusal (no google account linked to the existing
      //    password member -> refuse to auto-link, never insert a duplicate) ──
      const beforeCollisionCount = (
        await withTenant(oauthAcmeId, (tx) => tx.select().from(schema.tenantMember))
      ).length;
      googleSub = "chrono-google-collision-1";
      googleEmail = "existing-oauth@acme.test";
      googleEmailVerified = false;
      const memberCollision = await driveMemberOAuth("oauth-acme");
      check(
        "member oauth: collision redirects with account_not_linked",
        memberCollision.location?.includes("error=account_not_linked") ?? false,
      );
      const afterCollisionCount = (
        await withTenant(oauthAcmeId, (tx) => tx.select().from(schema.tenantMember))
      ).length;
      check(
        "member oauth: collision inserted no new member row",
        afterCollisionCount === beforeCollisionCount,
      );
      googleEmailVerified = true;

      // ── suspended-member refusal ──
      googleSub = "chrono-google-suspended-1";
      googleEmail = "suspended-oauth@acme.test";
      const memberSuspendedAttempt = await driveMemberOAuth("oauth-acme");
      check(
        "member oauth: suspended member is refused a session",
        memberSuspendedAttempt.location?.includes("error=account_suspended") ?? false,
      );
      check(
        "member oauth: suspended member gets no session cookie",
        memberSuspendedAttempt.setCookie.every((c) => !c.startsWith("agora_member=")),
      );

      // ── missing provider email -> email_required ──
      googleSub = "chrono-google-no-email";
      const noEmailStart = await reqNoFollow("GET", "/portal/auth/google/start?tenant=oauth-acme");
      const noEmailCookie = jar(noEmailStart.setCookie);
      const noEmailAuthorizeUrl = new URL(noEmailStart.location!);
      const noEmailState = noEmailAuthorizeUrl.searchParams.get("state")!;
      const noEmailToken = fakeIdToken({
        iss: "https://accounts.google.com",
        aud: "e2e-google-client-id",
        sub: "chrono-google-no-email",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = String(input);
        if (url.startsWith(base)) return realFetch(input, init);
        if (url.startsWith("https://oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ id_token: noEmailToken }), { status: 200 });
        }
        throw new Error(`Unexpected fetch in member OAuth e2e (no-email leg): ${url}`);
      }) as typeof fetch;
      const noEmailCallback = await reqNoFollow(
        "GET",
        `/portal/auth/google/callback?code=test-code&state=${encodeURIComponent(noEmailState)}`,
        { cookie: noEmailCookie },
      );
      check(
        "member oauth: missing provider email aborts with email_required",
        noEmailCallback.location?.includes("error=email_required") ?? false,
      );

      // ── IdP-declined consent -> cancelled ──
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = String(input);
        if (url.startsWith(base)) return realFetch(input, init);
        if (url.startsWith("https://oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              id_token: fakeIdToken({
                iss: "https://accounts.google.com",
                aud: "e2e-google-client-id",
                sub: "chrono-google-cancel",
                email: "cancel-oauth@example.com",
                email_verified: true,
                exp: Math.floor(Date.now() / 1000) + 3600,
              }),
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch in member OAuth e2e (cancel leg): ${url}`);
      }) as typeof fetch;
      const memberCancelled = await driveMemberOAuth("oauth-acme", { simulateCancel: true });
      check(
        "member oauth: IdP-declined consent aborts with cancelled",
        memberCancelled.location?.includes("error=cancelled") ?? false,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  // ── Global customer portal social login (chrono/global-portal-social-login
  // plan, Phase 8) ──
  // Re-runs the foundation's own customer-oauth.test.ts case list
  // (facebook-unconfigured 404, create-on-first-login, reuse-on-second-login,
  // Facebook-email-collision refusal, suspended-customer refusal,
  // missing-email -> email_required, IdP-decline -> cancelled, and the
  // apply-to-tenant composition case) against THIS app's database — the same
  // "prove it locally per consuming app" reasoning as the member-oauth block
  // immediately above. Cross-tenant separation is dropped, exactly like the
  // foundation's own test: Customers/CustomerOAuthAccounts is a platform-wide
  // pool with no tenant dimension at all.
  {
    // A dedicated, disposable tenant for the one case that touches a tenant
    // at all (the apply-to-tenant composition case) — NOT the shared
    // acmeId/contosoId fixtures, for the same file-ordering-independence
    // reason the member-oauth block above uses oauth-acme/oauth-contoso.
    const customerOauthOrgId = await ensureOrg("oauth-customer", "OAuth Customer Co");

    const realFetch = globalThis.fetch;
    let googleSub = "chrono-customer-google-sub-1";
    let googleEmail = "newplayer-customer@example.com";
    const googleEmailVerified = true;
    const facebookId = "chrono-customer-fb-id-1";
    const facebookEmail: string | null = "existing-customer-oauth@example.com";

    function fakeIdToken(claims: Record<string, unknown>): string {
      const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
    }

    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = String(input);
      if (url.startsWith(base)) return realFetch(input, init);
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        return new Response(
          JSON.stringify({
            id_token: fakeIdToken({
              iss: "https://accounts.google.com",
              aud: "e2e-google-client-id",
              sub: googleSub,
              email: googleEmail,
              email_verified: googleEmailVerified,
              name: "New Player",
              exp: Math.floor(Date.now() / 1000) + 3600,
            }),
          }),
          { status: 200 },
        );
      }
      if (url.startsWith("https://graph.facebook.com") && url.includes("/oauth/access_token")) {
        return new Response(JSON.stringify({ access_token: "fb-access-token" }), { status: 200 });
      }
      if (url.startsWith("https://graph.facebook.com") && url.includes("/me")) {
        return new Response(
          JSON.stringify({ id: facebookId, name: "FB Player", email: facebookEmail ?? undefined }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch in customer OAuth e2e: ${url}`);
    }) as typeof fetch;

    try {
      // A pre-existing password-only global customer, for the Facebook
      // collision case.
      await adminDb.insert(schema.customer).values({
        email: "existing-customer-oauth@example.com",
        name: "Existing OAuth Customer",
        passwordHash: "scrypt$deadbeef$deadbeef",
      });
      // A suspended global customer with a linked google account, for the
      // suspended case.
      const [suspendedCustomer] = await adminDb
        .insert(schema.customer)
        .values({
          email: "suspended-customer-oauth@example.com",
          name: "Suspended OAuth Customer",
          passwordHash: null,
          status: "suspended",
        })
        .returning({ id: schema.customer.id });
      await adminDb.insert(schema.customerOAuthAccount).values({
        customerId: suspendedCustomer!.id,
        provider: "google",
        providerAccountId: "chrono-customer-google-suspended-1",
        email: "suspended-customer-oauth@example.com",
      });

      // ── provider-unavailable: facebook has no credentials yet
      // (deliberately left unconfigured up to this point in the whole run,
      // exactly like the member-oauth block above) ──
      const fbUnavailable = await reqNoFollow("GET", "/auth/customer/facebook/start");
      check("customer oauth: facebook /start 404s while unconfigured", fbUnavailable.status === 404);

      async function driveCustomerOAuth(
        provider: "google" | "facebook",
        opts: { simulateCancel?: boolean } = {},
      ): Promise<NoFollowRes> {
        const start = await reqNoFollow("GET", `/auth/customer/${provider}/start`);
        if (start.status !== 302) {
          throw new Error(`customer oauth /start did not redirect: ${start.status}`);
        }
        const cookie = jar(start.setCookie);
        const authorizeUrl = new URL(start.location!);
        const state = authorizeUrl.searchParams.get("state")!;
        const cb = opts.simulateCancel
          ? `/auth/customer/${provider}/callback?state=${encodeURIComponent(state)}&error=access_denied`
          : `/auth/customer/${provider}/callback?code=test-code&state=${encodeURIComponent(state)}`;
        return reqNoFollow("GET", cb, { cookie });
      }

      // ── create-on-first-login ──
      const customerFirst = await driveCustomerOAuth("google");
      check(
        "customer oauth: google create-on-first-login redirects to /portal",
        customerFirst.location?.includes("/portal") ?? false,
        customerFirst.location ?? "",
      );
      const customersAfterFirst = await adminDb.select().from(schema.customer);
      const createdCustomer = customersAfterFirst.find((c) => c.email === googleEmail);
      check("customer oauth: create-on-first-login inserted exactly one Customers row", !!createdCustomer);
      check(
        "customer oauth: created customer has passwordHash null (OAuth-only)",
        createdCustomer?.passwordHash === null,
      );
      const oauthAccountsAfterFirst = await adminDb.select().from(schema.customerOAuthAccount);
      check(
        "customer oauth: create-on-first-login inserted a CustomerOAuthAccounts row",
        !!oauthAccountsAfterFirst.find(
          (a) => a.customerId === createdCustomer?.id && a.provider === "google",
        ),
      );

      // ── reuse-on-second-login: same providerAccountId, no duplicate rows ──
      const customerSecond = await driveCustomerOAuth("google");
      check(
        "customer oauth: reuse-on-second-login redirects to /portal",
        customerSecond.location?.includes("/portal") ?? false,
      );
      const customersAfterSecond = await adminDb.select().from(schema.customer);
      check(
        "customer oauth: no duplicate Customers row on second login",
        customersAfterSecond.filter((c) => c.email === googleEmail).length === 1,
      );
      const oauthAccountsAfterSecond = await adminDb.select().from(schema.customerOAuthAccount);
      check(
        "customer oauth: no duplicate CustomerOAuthAccounts row on second login",
        oauthAccountsAfterSecond.filter(
          (a) => a.provider === "google" && a.providerAccountId === googleSub,
        ).length === 1,
      );

      // ── cross-tenant separation: dropped intentionally, exactly like the
      // foundation's own customer-oauth.test.ts — Customers/
      // CustomerOAuthAccounts has no tenant dimension at all. ──

      // ── Facebook-email-collision refusal — needs Facebook actually
      // configured, so briefly enable it and wait out
      // resolveAuthProviders()'s 5s cache before driving the flow. ──
      process.env.FACEBOOK_AUTH_KEY = "e2e-facebook-client-id";
      process.env.FACEBOOK_AUTH_SECRET = "e2e-facebook-client-secret";
      await new Promise((resolve) => setTimeout(resolve, 5200));
      const beforeCollisionCount = (await adminDb.select().from(schema.customer)).length;
      const customerCollision = await driveCustomerOAuth("facebook");
      check(
        "customer oauth: facebook collision redirects with account_not_linked",
        customerCollision.location?.includes("error=account_not_linked") ?? false,
      );
      const afterCollisionCount = (await adminDb.select().from(schema.customer)).length;
      check(
        "customer oauth: facebook collision inserted no new Customers row",
        afterCollisionCount === beforeCollisionCount,
      );

      // ── suspended-customer refusal ──
      googleSub = "chrono-customer-google-suspended-1";
      googleEmail = "suspended-customer-oauth@example.com";
      const customerSuspendedAttempt = await driveCustomerOAuth("google");
      check(
        "customer oauth: suspended customer is refused a session",
        customerSuspendedAttempt.location?.includes("error=account_suspended") ?? false,
      );
      check(
        "customer oauth: suspended customer gets no session cookie",
        customerSuspendedAttempt.setCookie.every((c) => !c.startsWith("agora_customer=")),
      );

      // ── missing provider email -> email_required ──
      googleSub = "chrono-customer-google-no-email";
      const noEmailStart = await reqNoFollow("GET", "/auth/customer/google/start");
      const noEmailCookie = jar(noEmailStart.setCookie);
      const noEmailAuthorizeUrl = new URL(noEmailStart.location!);
      const noEmailState = noEmailAuthorizeUrl.searchParams.get("state")!;
      const noEmailToken = fakeIdToken({
        iss: "https://accounts.google.com",
        aud: "e2e-google-client-id",
        sub: "chrono-customer-google-no-email",
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = String(input);
        if (url.startsWith(base)) return realFetch(input, init);
        if (url.startsWith("https://oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ id_token: noEmailToken }), { status: 200 });
        }
        throw new Error(`Unexpected fetch in customer OAuth e2e (no-email leg): ${url}`);
      }) as typeof fetch;
      const noEmailCallback = await reqNoFollow(
        "GET",
        `/auth/customer/google/callback?code=test-code&state=${encodeURIComponent(noEmailState)}`,
        { cookie: noEmailCookie },
      );
      check(
        "customer oauth: missing provider email aborts with email_required",
        noEmailCallback.location?.includes("error=email_required") ?? false,
      );

      // ── IdP-declined consent -> cancelled ──
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        const url = String(input);
        if (url.startsWith(base)) return realFetch(input, init);
        if (url.startsWith("https://oauth2.googleapis.com/token")) {
          return new Response(
            JSON.stringify({
              id_token: fakeIdToken({
                iss: "https://accounts.google.com",
                aud: "e2e-google-client-id",
                sub: "chrono-customer-google-cancel",
                email: "cancel-customer-oauth@example.com",
                email_verified: true,
                exp: Math.floor(Date.now() / 1000) + 3600,
              }),
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch in customer OAuth e2e (cancel leg): ${url}`);
      }) as typeof fetch;
      const customerCancelled = await driveCustomerOAuth("google", { simulateCancel: true });
      check(
        "customer oauth: IdP-declined consent aborts with cancelled",
        customerCancelled.location?.includes("error=cancelled") ?? false,
      );

      // ── composition: an OAuth-created global customer can still self-
      // service "apply" to a tenant via the untouched POST /portal/customer/
      // apply route. `createdCustomer` (from the create-on-first-login case
      // above) is the OAuth-only global customer. ──
      const applyToken = "chrono-customer-oauth-e2e-apply-token";
      await adminDb.insert(schema.customerSession).values({
        customerId: createdCustomer!.id,
        tokenHash: createHash("sha256").update(applyToken).digest("hex"),
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      });
      const applyRes = await req("POST", "/portal/customer/apply", {
        cookie: `agora_customer=${applyToken}`,
        slug: "oauth-customer",
      });
      check(
        "customer oauth: OAuth-created global customer applies to a tenant (201)",
        applyRes.status === 201,
        `status ${applyRes.status} ${JSON.stringify(applyRes.body)}`,
      );
      const oauthCustomerOrgMembers = await withTenant(customerOauthOrgId, (tx) =>
        tx.select().from(schema.tenantMember),
      );
      check(
        "customer oauth: apply created a tenantMember row linked via customerId",
        !!oauthCustomerOrgMembers.find((m) => m.customerId === createdCustomer!.id),
      );
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.FACEBOOK_AUTH_KEY;
      delete process.env.FACEBOOK_AUTH_SECRET;
    }
  }

  // ── teardown ──
  await new Promise<void>((r) => server!.close(() => r()));
  await (pool.end?.() ?? Promise.resolve());

  // ── summary ──
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("Failures:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("E2E: PASS ✅");
  process.exit(0);
}

main().catch((err) => {
  console.error("E2E crashed:", err);
  process.exit(1);
});
