import { test, expect, type Page } from "@playwright/test";

/**
 * Browser coverage for the two `/api/auth/*` HTTP-surface blocks added in
 * Phase 3b (`apps/api/src/app.ts`, `normalizeAuthPath` in
 * `packages/agora/src/server/auth-path.ts`) — Blocker 1 of
 * `.ai/plans/agora/archive/tenant-impersonation`:
 *
 *   1. The Better Auth `admin` plugin's own HTTP surface is blocked outright
 *      (404), for any session, under `//`-doubled, trailing-slash, and
 *      `%2F`-encoded variants alike — Hono pattern-matches the *raw* path
 *      before any handler runs, so the block has to hold on every encoding.
 *   2. The Organization plugin's mutating HTTP surface (e.g.
 *      `/organization/delete`, `/organization/update-member-role`) is
 *      blocked (404) while impersonating, even though the impersonated
 *      session's real membership role is `owner`.
 *   3. Better Auth's own CORE mutating HTTP surface directly under
 *      `/api/auth/` (e.g. `/update-user`, `/revoke-sessions`) — which
 *      authorizes on nothing but a valid session — is ALSO blocked (404)
 *      while impersonating, not just the Organization plugin's routes.
 *
 * Same conventions as `impersonation.spec.ts` (real dev DB, `workers: 1`,
 * throwaway `test-<timestamp>` orgs, `x-platform-admin: "1"`).
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

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

test.describe("Impersonation HTTP-surface blocks", () => {
  test("the Better Auth admin plugin's HTTP surface 404s under every path-encoding variant", async ({
    page,
  }) => {
    // Any session at all — this block is unconditional, not impersonation-only.
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const variants = [
      "/api/auth/admin/impersonate-user",
      "/api/auth//admin/impersonate-user",
      "/api/auth/admin/impersonate-user/",
      "/api/auth/admin%2Fimpersonate-user",
    ];

    for (const path of variants) {
      const res = await page.request.post(`${API_URL}${path}`, {
        headers: { "Content-Type": "application/json" },
        data: { userId: "irrelevant" },
      });
      expect(res.status(), `expected 404 for ${path}`).toBe(404);
    }
  });

  test("the organization plugin's mutating HTTP surface 404s while impersonating, despite a real owner target", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-imp-http-block${uniq}`;
    const ownerEmail = `test-imp-http-block-owner${uniq}@example.com`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUpWorkspace(page, { name: "HTTP Block Owner", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { orgId, ownerUserId } = await findOrgAndOwner(adminPage, slug);

    const startRes = await adminPage.request.post(
      `${API_URL}/rpc-admin/impersonation/start`,
      { headers: { "x-platform-admin": "1" }, data: { targetUserId: ownerUserId } },
    );
    expect(startRes.ok()).toBeTruthy();

    await adminPage.goto(`${base}/dashboard`);

    const deleteRes = await adminPage.request.post(
      `${API_URL}/api/auth/organization/delete`,
      { headers: { "Content-Type": "application/json" }, data: { organizationId: orgId } },
    );
    expect(deleteRes.status()).toBe(404);

    const updateRoleRes = await adminPage.request.post(
      `${API_URL}/api/auth/organization/update-member-role`,
      {
        headers: { "Content-Type": "application/json" },
        data: { organizationId: orgId, memberId: ownerUserId, role: "admin" },
      },
    );
    expect(updateRoleRes.status()).toBe(404);

    // Better Auth's own CORE endpoints (not the Organization plugin's) must
    // be blocked too — they authorize on nothing but a valid session, so an
    // impersonating admin could otherwise rewrite the target's profile or
    // log them out of every device unaudited.
    const updateUserRes = await adminPage.request.post(
      `${API_URL}/api/auth/update-user`,
      { headers: { "Content-Type": "application/json" }, data: { name: "Hijacked" } },
    );
    expect(updateUserRes.status()).toBe(404);

    const revokeSessionsRes = await adminPage.request.post(
      `${API_URL}/api/auth/revoke-sessions`,
      { headers: { "Content-Type": "application/json" }, data: {} },
    );
    expect(revokeSessionsRes.status()).toBe(404);

    await adminPage.request.post(`${API_URL}/rpc-admin/impersonation/stop`, {
      headers: { "x-platform-admin": "1" },
    });

    await adminContext.close();
  });
});
