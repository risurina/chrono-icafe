/**
 * State-machine test for inquiries (inquiries Phase 3,
 * `.ai/plans/chrono/active/inquiries/README.md` — "Verification Commands"
 * deliverable).
 *
 * Proves the new -> assigned -> in_progress -> resolved -> closed
 * transitions, the 409 guard on a closed inquiry's status route, AND the
 * auto-reopen case (a customer portal reply on a resolved/closed inquiry
 * reopens it to in_progress) — against a REAL Postgres connection, exercised
 * through the real Hono app over HTTP. Mirrors
 * `apps/chrono-api/src/modules/security-alert/state-machine.test.ts`'s
 * setup/style.
 *
 * Requires `TEST_DATABASE_URL` (a dedicated `*test*`-named database, isolated
 * from dev/prod — see `apps/chrono-api/.env.example`). Skips gracefully with
 * a clear message when it isn't set.
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
      "\ninquiry state-machine.test skipped: TEST_DATABASE_URL is not set.\n" +
        "  Set it to a dedicated *test*-named database to run this test.\n",
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
    `\ninquiry state-machine.test mode: REAL database "${dbName}" (app role for runtime, admin role for schema setup)`,
  );

  process.env.APP_DOMAIN = "localtest.me:3000";
  process.env.BETTER_AUTH_SECRET = "e2e-secret-e2e-secret-e2e-secret-0123";
  process.env.WEB_ORIGIN = "http://localtest.me:3000";
  process.env.NODE_ENV = "test";
  process.env.DOMAIN_PROVIDER = "noop";
  process.env.INTERNAL_JOB_TOKEN = "e2e-internal-token";
  process.env.STORAGE_PROVIDER = "local";

  // 1. Register Chrono's own permission resources BEFORE anything imports
  // agora/auth (which freezes the shared registry on first read).
  const { registerChronoPermissions } = await import("../../auth/permissions");
  registerChronoPermissions();

  // 2. Import the app + foundation (this connects the db).
  const { app } = await import("../../app");
  const { auth } = await import("agora/auth");
  const { adminDb, adminPool, pool, schema, applyRls, BASE_TENANT_TABLES } = await import("agora/db");
  const { APP_TENANT_TABLES } = await import("../../db/schema");
  const { createId } = await import("agora");

  const appSchema = await import("../../db/schema");
  const tables = Object.values(appSchema).filter((v) => is(v, PgTable)) as PgTable[];

  // 3. Reset → migrate (create schema) → RLS.
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

  // 4. Seed tenant A (staff owner) + tenant B (cross-tenant isolation check)
  // + one tenantMember (portal, cross-member isolation check) in tenant A.
  console.log("  seeding…");
  const PW = "Password123!";
  const r = await auth.api.signUpEmail({
    body: { email: "owner@inquiry.test", password: PW, name: "Inquiry Owner" },
  });
  const ownerUserId = r.user.id;
  const tenantId = createId();
  await adminDb.insert(schema.organization).values({ id: tenantId, slug: "inquiryco", name: "Inquiry Co" });
  await adminDb.insert(schema.member).values({
    id: createId(),
    organizationId: tenantId,
    userId: ownerUserId,
    role: "owner",
  });

  const otherTenantId = createId();
  await adminDb.insert(schema.organization).values({ id: otherTenantId, slug: "otherinquiryco", name: "Other Co" });
  const r2 = await auth.api.signUpEmail({
    body: { email: "owner@otherinquiryco.test", password: PW, name: "Other Owner" },
  });
  await adminDb.insert(schema.member).values({
    id: createId(),
    organizationId: otherTenantId,
    userId: r2.user.id,
    role: "owner",
  });

  // 5. Start the real HTTP server on an ephemeral port.
  const { serve } = await import("@hono/node-server");
  let server: { close: (cb?: () => void) => void };
  const port: number = await new Promise((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });
  const base = `http://127.0.0.1:${port}`;

  const jar = (cookies: string[]) => cookies.map((c) => c.split(";")[0]).join("; ");
  const signIn = await auth.api.signInEmail({
    body: { email: "owner@inquiry.test", password: PW },
    asResponse: true,
  });
  const ownerCookie = jar(signIn.headers.getSetCookie());
  const otherSignIn = await auth.api.signInEmail({
    body: { email: "owner@otherinquiryco.test", password: PW },
    asResponse: true,
  });
  const otherCookie = jar(otherSignIn.headers.getSetCookie());

  async function call(
    method: string,
    path: string,
    opts: { cookie?: string; tenantSlug?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; body: any; headers: Headers }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        "x-tenant-slug": opts.tenantSlug ?? "inquiryco",
        cookie: opts.cookie ?? ownerCookie,
        "content-type": "application/json",
        ...opts.headers,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: res.status, body, headers: res.headers };
  }

  // ── Anonymous public submission (unauthenticated, host-resolved) ──
  console.log("\nSubmitting a public inquiry…\n");
  const publicRes = await call("POST", "/public/inquiries", {
    headers: { "x-tenant-slug": "inquiryco" },
    body: {
      submitterName: "Visitor One",
      submitterEmail: "visitor@example.com",
      category: "general",
      subject: "Do you have PS5s at Makati?",
      message: "Just checking availability.",
    },
  });
  check("public submission returns 201", publicRes.status === 201, JSON.stringify(publicRes.body));

  // ── Staff list to find the new inquiry's id ──
  const listRes = await call("GET", "/rpc/inquiries");
  check("staff list returns 200", listRes.status === 200, JSON.stringify(listRes.body));
  const inquiryId = listRes.body?.items?.[0]?.id as string | undefined;
  check("staff sees the new inquiry", typeof inquiryId === "string" && inquiryId.length > 0);
  check(
    "new inquiry starts in 'new' status",
    listRes.body?.items?.[0]?.status === "new",
    JSON.stringify(listRes.body?.items?.[0]),
  );

  // ── new -> assigned ──
  console.log("\nAssigning the inquiry…\n");
  const assignRes = await call("POST", `/rpc/inquiries/${inquiryId}/assign`, { body: {} });
  check("assign returns 200", assignRes.status === 200, JSON.stringify(assignRes.body));
  check(
    "assigned inquiry is in 'assigned' status",
    assignRes.body?.inquiry?.status === "assigned",
    JSON.stringify(assignRes.body),
  );

  // ── assigned -> in_progress (via staff reply) ──
  console.log("\nStaff replying…\n");
  const replyRes = await call("POST", `/rpc/inquiries/${inquiryId}/reply`, {
    body: { body: "Yes, PS5s are available at our Makati branch!" },
  });
  check("reply returns 201", replyRes.status === 201, JSON.stringify(replyRes.body));
  check(
    "replied inquiry moves to 'in_progress'",
    replyRes.body?.inquiry?.status === "in_progress",
    JSON.stringify(replyRes.body),
  );

  // ── in_progress -> resolved ──
  console.log("\nResolving the inquiry…\n");
  const resolveRes = await call("PATCH", `/rpc/inquiries/${inquiryId}/status`, {
    body: { status: "resolved" },
  });
  check("resolve returns 200", resolveRes.status === 200, JSON.stringify(resolveRes.body));
  check(
    "resolved inquiry is in 'resolved' status",
    resolveRes.body?.inquiry?.status === "resolved",
    JSON.stringify(resolveRes.body),
  );

  // ── resolved -> closed ──
  console.log("\nClosing the inquiry…\n");
  const closeRes = await call("PATCH", `/rpc/inquiries/${inquiryId}/status`, {
    body: { status: "closed" },
  });
  check("close returns 200", closeRes.status === 200, JSON.stringify(closeRes.body));
  check(
    "closed inquiry is in 'closed' status",
    closeRes.body?.inquiry?.status === "closed",
    JSON.stringify(closeRes.body),
  );
  check("closed inquiry carries a closedAt timestamp", !!closeRes.body?.inquiry?.closedAt);

  // ── Wrong-state: staff status-route can't move a closed inquiry to a
  // non-closed status without a reply reopening it first ──
  console.log("\nWrong-state: PATCHing a closed inquiry back to 'in_progress' → 409…\n");
  const badReopenRes = await call("PATCH", `/rpc/inquiries/${inquiryId}/status`, {
    body: { status: "in_progress" },
  });
  check(
    "PATCHing a closed inquiry to a non-closed status returns 409",
    badReopenRes.status === 409,
    JSON.stringify(badReopenRes.body),
  );

  // ── Auto-reopen: a portal customer reply on a resolved/closed inquiry
  // reopens it to in_progress. Requires a real tenantMember portal session —
  // the identified-submitter path, so submit a fresh portal inquiry first.
  console.log("\nAuto-reopen case: seeding a tenantMember + a portal inquiry…\n");
  const signUpRes = await call("POST", "/portal/auth/sign-up", {
    body: { email: "customer@inquiry.test", password: PW, name: "Customer One" },
  });
  check("portal member sign-up returns 2xx", signUpRes.status >= 200 && signUpRes.status < 300, JSON.stringify(signUpRes.body));
  const memberCookie = jar(signUpRes.headers.getSetCookie ? signUpRes.headers.getSetCookie() : []);

  const submitPortalRes = await call("POST", "/portal/inquiries", {
    cookie: memberCookie,
    body: { category: "billing", subject: "Wallet balance question", message: "Where did my credits go?" },
  });
  check("portal submit returns 201", submitPortalRes.status === 201, JSON.stringify(submitPortalRes.body));
  const portalInquiryId = submitPortalRes.body?.inquiry?.id as string | undefined;

  // Staff resolves then closes it.
  await call("POST", `/rpc/inquiries/${portalInquiryId}/assign`, { body: {} });
  await call("PATCH", `/rpc/inquiries/${portalInquiryId}/status`, { body: { status: "resolved" } });
  const closePortalRes = await call("PATCH", `/rpc/inquiries/${portalInquiryId}/status`, {
    body: { status: "closed" },
  });
  check(
    "portal inquiry is closed before the reopen check",
    closePortalRes.body?.inquiry?.status === "closed",
    JSON.stringify(closePortalRes.body),
  );

  console.log("\nCustomer replies on the closed inquiry — should auto-reopen…\n");
  const reopenReplyRes = await call("POST", `/portal/inquiries/${portalInquiryId}/reply`, {
    cookie: memberCookie,
    body: { body: "This still isn't resolved, please help again." },
  });
  check("customer reply on a closed inquiry returns 201", reopenReplyRes.status === 201, JSON.stringify(reopenReplyRes.body));
  check(
    "AUTO-REOPEN: closed inquiry reopens to 'in_progress' after a customer reply",
    reopenReplyRes.body?.inquiry?.status === "in_progress",
    JSON.stringify(reopenReplyRes.body),
  );
  check(
    "AUTO-REOPEN: closedAt is cleared on reopen",
    reopenReplyRes.body?.inquiry?.closedAt === null,
    JSON.stringify(reopenReplyRes.body),
  );

  // ── Cross-member isolation: a second tenantMember cannot see the first
  // member's inquiry ──
  console.log("\nCross-member isolation: a second customer cannot see the first customer's inquiry…\n");
  const signUp2Res = await call("POST", "/portal/auth/sign-up", {
    body: { email: "customer2@inquiry.test", password: PW, name: "Customer Two" },
  });
  const member2Cookie = jar(signUp2Res.headers.getSetCookie ? signUp2Res.headers.getSetCookie() : []);
  const crossMemberRes = await call("GET", `/portal/inquiries/${portalInquiryId}`, { cookie: member2Cookie });
  check(
    "a different member's own-inquiry lookup 404s, never leaks the row",
    crossMemberRes.status === 404,
    JSON.stringify(crossMemberRes.body),
  );
  const crossMemberListRes = await call("GET", "/portal/inquiries", { cookie: member2Cookie });
  check(
    "a different member's own-inquiry list is empty",
    crossMemberListRes.status === 200 &&
      Array.isArray(crossMemberListRes.body?.items) &&
      crossMemberListRes.body.items.length === 0,
    JSON.stringify(crossMemberListRes.body),
  );

  // ── Cross-tenant isolation: tenant B's staff never sees tenant A's rows ──
  console.log("\nCross-tenant isolation: a different tenant's owner cannot see or act on this inquiry…\n");
  const crossTenantListRes = await call("GET", "/rpc/inquiries", {
    cookie: otherCookie,
    tenantSlug: "otherinquiryco",
  });
  check(
    "a different tenant's list is empty (RLS-scoped)",
    crossTenantListRes.status === 200 &&
      Array.isArray(crossTenantListRes.body?.items) &&
      crossTenantListRes.body.items.length === 0,
    JSON.stringify(crossTenantListRes.body),
  );
  const crossTenantAssignRes = await call("POST", `/rpc/inquiries/${inquiryId}/assign`, {
    cookie: otherCookie,
    tenantSlug: "otherinquiryco",
    body: {},
  });
  check(
    "assigning another tenant's inquiry returns 404, never 403/500",
    crossTenantAssignRes.status === 404,
    JSON.stringify(crossTenantAssignRes.body),
  );

  server!.close();
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
