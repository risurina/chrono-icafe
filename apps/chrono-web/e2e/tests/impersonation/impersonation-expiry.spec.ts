import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Browser coverage for the impersonation grant's hard TTL (Condition 4,
 * `.ai/plans/agora/archive/tenant-impersonation`): `enforceImpersonationGrant()` in
 * `packages/agora/src/server/tenant.ts` closes an expired grant on the next
 * tenant request and 401s it, and does so exactly once — a second request
 * against the same already-closed grant must not write a second
 * `impersonation.expired` platform-audit row.
 *
 * The 30-minute expiry has no client-settable path by design (it is enforced
 * purely server-side against the grant row's own `expiresAt`, independent of
 * Better Auth's session TTL — see Condition 4's rationale), so there is no
 * route this suite can call to shorten it, and `.ai/rules/e2e-testing.md`'s
 * "no sleeping in the test" instruction rules out waiting for the real
 * expiry. No existing spec in `apps/web/e2e` reaches into the database
 * directly — every other spec drives state through the real HTTP surface —
 * so this is a judgment call: `loadApiEnv()` below loads the running API's
 * own `apps/api/.env` into this Node (Playwright) process, then this test
 * imports `agora/db` directly (the same `adminDb` driver `apps/api/src/seed.ts`
 * already uses ad hoc) to issue one UPDATE backdating the grant's `expiresAt`.
 * This never bypasses RLS or forges a session — it only rewrites a timestamp
 * on a non-RLS-scoped operational table (`platform_impersonation_grant`,
 * `.ai/rules/database.md`) that has no other write path once minted. If a
 * dedicated test-only mutation route is ever preferred instead, add it under
 * its own plan phase rather than folding it into this one.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

function loadApiEnv() {
  const envPath = path.resolve(__dirname, "../../../../api/.env");
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function signUpWorkspace(
  page: Page,
  opts: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Business name").fill(opts.slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${opts.slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function signInStaff(page: Page, host: string, email: string) {
  await page.goto(`http://${host}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

async function findOrgAndOwner(adminPage: Page, slug: string) {
  const orgsRes = await adminPage.request.get(
    `${API_URL}/rpc-admin/organizations?search=${slug}`,
    { headers: { "x-platform-admin": "1" } },
  );
  const orgsBody = (await orgsRes.json()) as { items: { id: string }[] };
  const orgId = orgsBody.items[0]?.id;
  expect(orgId).toBeTruthy();

  const membersRes = await adminPage.request.get(
    `${API_URL}/rpc-admin/organizations/${orgId}/members`,
    { headers: { "x-platform-admin": "1" } },
  );
  const membersBody = (await membersRes.json()) as {
    items: { userId: string; role: string }[];
  };
  const owner = membersBody.items.find((m) => m.role === "owner");
  expect(owner).toBeTruthy();
  return { orgId: orgId!, ownerUserId: owner!.userId };
}

async function findUserId(adminPage: Page, email: string): Promise<string> {
  const res = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, {
    headers: { "x-platform-admin": "1" },
  });
  const body = (await res.json()) as { items: { userId: string; email: string }[] };
  const found = body.items.find((i) => i.email === email);
  expect(found).toBeTruthy();
  return found!.userId;
}

test.describe("Impersonation expiry", () => {
  test("an expired grant 401s the next tenant request and closes with exactly one impersonation.expired audit row", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-imp-expiry${uniq}`;
    const ownerEmail = `test-imp-expiry-owner${uniq}@example.com`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUpWorkspace(page, { name: "Expiry Owner", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { ownerUserId } = await findOrgAndOwner(adminPage, slug);
    const platformAdminUserId = await findUserId(adminPage, PLATFORM_ADMIN_EMAIL);

    const startRes = await adminPage.request.post(
      `${API_URL}/rpc-admin/impersonation/start`,
      { headers: { "x-platform-admin": "1" }, data: { targetUserId: ownerUserId } },
    );
    expect(startRes.ok()).toBeTruthy();

    // Backdate the grant's expiresAt directly — see the file header for why.
    loadApiEnv();
    const { adminDb, schema, eq, and, isNull } = await import("agora/db");
    await adminDb
      .update(schema.platformImpersonationGrant)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(
        and(
          eq(schema.platformImpersonationGrant.actorId, platformAdminUserId),
          eq(schema.platformImpersonationGrant.targetUserId, ownerUserId),
          isNull(schema.platformImpersonationGrant.endedAt),
        ),
      );

    // `start` swaps adminPage's own session cookie to the target's — it is no
    // longer an admin session. Audit checks need a SEPARATE, still-admin
    // session, so sign in again in a fresh context for those.
    const auditorContext = await browser.newContext();
    const auditorPage = await auditorContext.newPage();
    await signInStaff(auditorPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    await adminPage.goto(`${base}/dashboard`);

    // First tenant request after backdating: 401, and closes the grant.
    const first = await adminPage.evaluate(async (s) => {
      const api = location.origin.replace(/:3000$/, ":8787");
      const res = await fetch(`${api}/rpc/me`, {
        credentials: "include",
        headers: { "x-tenant-slug": s },
      });
      return { status: res.status };
    }, slug);
    expect(first.status).toBe(401);

    const auditAfterFirst = await auditorPage.request.get(
      `${API_URL}/rpc-admin/audit?q=impersonation.expired&pageSize=100`,
      { headers: { "x-platform-admin": "1" } },
    );
    const bodyAfterFirst = (await auditAfterFirst.json()) as {
      items: { action: string; targetId: string | null }[];
    };
    const expiredAfterFirst = bodyAfterFirst.items.filter(
      (i) => i.action === "impersonation.expired" && i.targetId === ownerUserId,
    );
    expect(expiredAfterFirst).toHaveLength(1);

    // Second tenant request against the now-already-closed grant: still 401,
    // but must not write a second audit row (single-fire).
    const second = await adminPage.evaluate(async (s) => {
      const api = location.origin.replace(/:3000$/, ":8787");
      const res = await fetch(`${api}/rpc/me`, {
        credentials: "include",
        headers: { "x-tenant-slug": s },
      });
      return { status: res.status };
    }, slug);
    expect(second.status).toBe(401);

    const auditAfterSecond = await auditorPage.request.get(
      `${API_URL}/rpc-admin/audit?q=impersonation.expired&pageSize=100`,
      { headers: { "x-platform-admin": "1" } },
    );
    const bodyAfterSecond = (await auditAfterSecond.json()) as {
      items: { action: string; targetId: string | null }[];
    };
    const expiredAfterSecond = bodyAfterSecond.items.filter(
      (i) => i.action === "impersonation.expired" && i.targetId === ownerUserId,
    );
    expect(expiredAfterSecond).toHaveLength(1);

    await adminContext.close();
  });
});
