import { test, expect, type Page } from "@playwright/test";

/**
 * Browser + API coverage for platform-admin-triggered tenant data export
 * (`.ai/plans/active/compliance-tooling/README.md`, Phase 6). Reuses the
 * conventions established by `platform-admin/support-tooling.spec.ts`:
 * `fullyParallel: false, workers: 1` against the real dev DB, a seeded
 * `platform@agora.test` admin, a throwaway `test-<timestamp>` org per test,
 * and `owner@contoso.test` borrowed as a throwaway viewer target (reverted
 * to `platformRole: null` in `afterEach`).
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
  await page.getByLabel("Workspace name").fill(opts.slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
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
  const orgId = adminPage.url().split("/").pop()!;
  return orgId;
}

/** Revert owner@contoso.test's platform role back to null, best-effort. */
async function revokeContosoRole(adminPage: Page) {
  const res = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, {
    headers: HDR,
  });
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
  const res = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, {
    headers: HDR,
  });
  const body = (await res.json()) as { items: { userId: string; email: string }[] };
  const contoso = body.items.find((i) => i.email === "owner@contoso.test");
  expect(contoso).toBeTruthy();
  await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${contoso!.userId}/role`, {
    headers: HDR,
    data: { role },
  });
}

test.describe("Platform Admin Compliance — Tenant Export", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await revokeContosoRole(page);
    await ctx.close();
  });

  test("an admin requests an export from the org detail page and it lands in history", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slugA = `test-export-a${uniq}`;
    const ownerEmailA = `test-export-owner-a${uniq}@example.com`;

    await signUpWorkspace(page, { name: "Export Owner A", email: ownerEmailA, slug: slugA });

    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await goToOrgDetail(page, slugA);

    await expect(page.getByText("No exports requested yet.")).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      (async () => {
        await page.getByRole("button", { name: "Request data export" }).click();
        await page.getByLabel("Reason (optional)").fill("e2e DSAR request");
        await page.getByRole("button", { name: "Export", exact: true }).click();
      })(),
    ]);
    expect(download.suggestedFilename()).toMatch(/export/);

    await expect(page.getByText("No exports requested yet.")).toHaveCount(0);
    await expect(page.getByText("e2e DSAR request")).toBeVisible();
  });

  test("cross-tenant isolation: org A's export/history never surfaces org B's rows", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slugA = `test-export-iso-a${uniq}`;
    const slugB = `test-export-iso-b${uniq}`;
    const ownerEmailA = `test-export-iso-owner-a${uniq}@example.com`;
    const ownerEmailB = `test-export-iso-owner-b${uniq}@example.com`;

    await signUpWorkspace(page, { name: "Iso Owner A", email: ownerEmailA, slug: slugA });
    const ctxB = await page.context().browser()!.newContext();
    const pageB = await ctxB.newPage();
    await signUpWorkspace(pageB, { name: "Iso Owner B", email: ownerEmailB, slug: slugB });

    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const orgIdA = await goToOrgDetail(page, slugA);
    const orgIdB = await goToOrgDetail(page, slugB);

    // Non-vacuous: seed a real export request against B, then confirm A's
    // history never contains it (mirrors the rls:proof non-vacuous convention).
    await page.request.post(
      `${API_URL}/rpc-admin/organizations/${orgIdB}/compliance/export`,
      { headers: HDR, data: { reason: "iso-check-b" } },
    );
    const historyA = await page.request.get(
      `${API_URL}/rpc-admin/organizations/${orgIdA}/compliance/exports`,
      { headers: HDR },
    );
    const bodyA = (await historyA.json()) as { items: { organizationId: string }[] };
    expect(bodyA.items.every((i) => i.organizationId === orgIdA)).toBe(true);

    await ctxB.close();
  });

  test("a tenant owner with no platform role gets 403 on export and history", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-export-gate${uniq}`;
    const ownerEmail = `test-export-gate-owner${uniq}@example.com`;
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

    const exportRes = await ownerPage.request.post(
      `${API_URL}/rpc-admin/organizations/${orgId}/compliance/export`,
      { headers: HDR, data: { reason: "should be blocked" } },
    );
    expect(exportRes.status()).toBe(403);
    const historyRes = await ownerPage.request.get(
      `${API_URL}/rpc-admin/organizations/${orgId}/compliance/exports`,
    );
    expect(historyRes.status()).toBe(403);
    await ctx.close();
  });

  test("viewer is blocked from export (403) but can read export history (200)", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-export-viewer${uniq}`;
    const ownerEmail = `test-export-viewer-owner${uniq}@example.com`;
    await signUpWorkspace(page, { name: "Viewer Owner", email: ownerEmail, slug });
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const orgId = await goToOrgDetail(page, slug);
    await setContosoRole(page, "viewer");

    const ctx = await browser.newContext();
    const viewerPage = await ctx.newPage();
    await signInStaff(viewerPage, "localtest.me:3000", "owner@contoso.test");

    const exportRes = await viewerPage.request.post(
      `${API_URL}/rpc-admin/organizations/${orgId}/compliance/export`,
      { headers: HDR, data: { reason: "should be blocked" } },
    );
    expect(exportRes.status()).toBe(403);

    const historyRes = await viewerPage.request.get(
      `${API_URL}/rpc-admin/organizations/${orgId}/compliance/exports`,
      { headers: HDR },
    );
    expect(historyRes.status()).toBe(200);

    await ctx.close();
  });
});
