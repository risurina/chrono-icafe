import { test, expect, type Page } from "@playwright/test";

/**
 * Browser + API coverage for platform-admin policy-acceptance versioning
 * (`.ai/plans/agora/active/compliance-tooling/README.md`, Phase 6). Same
 * conventions as `export.spec.ts` / `support-tooling.spec.ts`.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const HDR = { "x-platform-admin": "1" };

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

async function goToOrgDetail(adminPage: Page, slug: string) {
  await adminPage.goto("http://localtest.me:3000/admin");
  await adminPage.waitForLoadState("networkidle");
  await adminPage.getByPlaceholder("Search organizations…").fill(slug);
  const row = adminPage.getByRole("row").filter({ hasText: slug });
  await row.getByRole("button", { name: "View" }).click();
  await adminPage.waitForURL(/\/admin\/organizations\/.+/);
  return adminPage.url().split("/").pop()!;
}

async function revokeContosoRole(adminPage: Page) {
  const res = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, { headers: HDR });
  if (!res.ok()) return;
  const body = (await res.json()) as { items: { userId: string; email: string }[] };
  const contoso = body.items.find((i) => i.email === "owner@contoso.test");
  if (contoso) {
    await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${contoso.userId}/role`, {
      headers: HDR,
      data: { role: null },
    });
  }
}

async function setContosoRole(adminPage: Page, role: "viewer" | "admin") {
  const res = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, { headers: HDR });
  const body = (await res.json()) as { items: { userId: string; email: string }[] };
  const contoso = body.items.find((i) => i.email === "owner@contoso.test");
  expect(contoso).toBeTruthy();
  await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${contoso!.userId}/role`, {
    headers: HDR,
    data: { role },
  });
}

test.describe("Platform Admin Compliance — Policy Versioning", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await revokeContosoRole(page);
    await ctx.close();
  });

  test("an admin records a policy acceptance from the org detail page and it persists", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slug = `test-policy${uniq}`;
    const ownerEmail = `test-policy-owner${uniq}@example.com`;
    await signUpWorkspace(page, { name: "Policy Owner", email: ownerEmail, slug });

    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await goToOrgDetail(page, slug);

    await expect(page.getByText("No policy acceptances recorded.")).toBeVisible();

    await page.getByLabel("Version").fill("2025-01-01");
    await page.getByRole("button", { name: "Record acceptance" }).click();

    await expect(page.getByText("No policy acceptances recorded.")).toHaveCount(0);
    await expect(page.getByText("2025-01-01")).toBeVisible();
    await expect(page.getByText("terms")).toBeVisible();

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("2025-01-01")).toBeVisible();
  });

  test("a conflicting organizationId in the body still writes under the path's :id", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slugA = `test-policy-conflict-a${uniq}`;
    const slugB = `test-policy-conflict-b${uniq}`;
    const ownerEmailA = `test-policy-conflict-owner-a${uniq}@example.com`;
    const ownerEmailB = `test-policy-conflict-owner-b${uniq}@example.com`;
    await signUpWorkspace(page, { name: "Conflict Owner A", email: ownerEmailA, slug: slugA });
    const ctxB = await page.context().browser()!.newContext();
    const pageB = await ctxB.newPage();
    await signUpWorkspace(pageB, { name: "Conflict Owner B", email: ownerEmailB, slug: slugB });

    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const orgIdA = await goToOrgDetail(page, slugA);
    const orgIdB = await goToOrgDetail(page, slugB);

    const res = await page.request.post(
      `${API_URL}/rpc-admin/organizations/${orgIdA}/compliance/policy`,
      {
        headers: HDR,
        data: {
          policyType: "privacy",
          version: "v-conflict",
          acceptedAt: new Date().toISOString(),
          organizationId: orgIdB,
        },
      },
    );
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as { organizationId: string };
    expect(body.organizationId).toBe(orgIdA);

    // Cross-org isolation: org B's list never shows the row written under A.
    const listB = await page.request.get(
      `${API_URL}/rpc-admin/organizations/${orgIdB}/compliance/policy`,
      { headers: HDR },
    );
    const listBBody = (await listB.json()) as { items: { organizationId: string }[] };
    expect(listBBody.items.every((i) => i.organizationId === orgIdB)).toBe(true);

    await ctxB.close();
  });

  test("a tenant owner with no platform role gets 403 on the policy routes", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-policy-gate${uniq}`;
    const ownerEmail = `test-policy-gate-owner${uniq}@example.com`;
    await signUpWorkspace(page, { name: "Gate Owner", email: ownerEmail, slug });
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const orgId = await goToOrgDetail(page, slug);

    const ctx = await browser.newContext();
    const ownerPage = await ctx.newPage();
    await ownerPage.goto(`http://${slug}.localtest.me:3000/login`);
    await ownerPage.waitForLoadState("networkidle");
    await ownerPage.getByLabel("Email").fill(ownerEmail);
    await ownerPage.getByLabel("Password").fill(SEEDED_PASSWORD);
    await ownerPage.getByRole("button", { name: /sign in/i }).click();
    await ownerPage.waitForURL((url) => !url.pathname.startsWith("/login"));

    const readRes = await ownerPage.request.get(
      `${API_URL}/rpc-admin/organizations/${orgId}/compliance/policy`,
    );
    expect(readRes.status()).toBe(403);
    const writeRes = await ownerPage.request.post(
      `${API_URL}/rpc-admin/organizations/${orgId}/compliance/policy`,
      {
        headers: HDR,
        data: { policyType: "terms", version: "x", acceptedAt: new Date().toISOString() },
      },
    );
    expect(writeRes.status()).toBe(403);
    await ctx.close();
  });

  test("viewer can read the policy list (200) but cannot record an acceptance (403)", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-policy-viewer${uniq}`;
    const ownerEmail = `test-policy-viewer-owner${uniq}@example.com`;
    await signUpWorkspace(page, { name: "Viewer Owner", email: ownerEmail, slug });
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const orgId = await goToOrgDetail(page, slug);
    await setContosoRole(page, "viewer");

    const ctx = await browser.newContext();
    const viewerPage = await ctx.newPage();
    await signInStaff(viewerPage, "localtest.me:3000", "owner@contoso.test");

    const readRes = await viewerPage.request.get(
      `${API_URL}/rpc-admin/organizations/${orgId}/compliance/policy`,
      { headers: HDR },
    );
    expect(readRes.status()).toBe(200);

    const writeRes = await viewerPage.request.post(
      `${API_URL}/rpc-admin/organizations/${orgId}/compliance/policy`,
      {
        headers: HDR,
        data: { policyType: "terms", version: "x", acceptedAt: new Date().toISOString() },
      },
    );
    expect(writeRes.status()).toBe(403);

    await ctx.close();
  });
});
