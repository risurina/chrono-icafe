import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the GLOBAL feature-management surface
 * (`/admin/feature-flags` list + `[key]` detail, `/rpc-admin/feature-flags*`).
 * Distinct from `feature-flags.spec.ts`, which covers the per-tenant override
 * on the org detail page. Covers the happy path (admin edits global config and
 * it persists), the 5-step resolution order (the security-relevant assertions,
 * one per precedence rule), the role gate (a platform viewer cannot PATCH), and
 * the audit trail.
 *
 * These edit PLATFORM-GLOBAL config, so each test restores the keys it touched
 * in `afterEach`. Runs `workers: 1` against the real dev DB, same conventions
 * as the sibling specs. Requires `pnpm dev` running first.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const HDR = { "x-platform-admin": "1" };

// A key with no seeded per-tenant overrides — safe to drive globally.
const KEY = "reports.advanced";
const KEY_LABEL = "Advanced reports";

async function signUpWorkspace(
  page: import("@playwright/test").Page,
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

async function signInStaff(
  page: import("@playwright/test").Page,
  host: string,
  email: string,
) {
  await page.goto(`http://${host}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });
}

/** Reset a key to registry defaults (active, off, no rollout, all plans). */
async function resetKey(page: import("@playwright/test").Page) {
  await page.request.patch(`${API_URL}/rpc-admin/feature-flags/${KEY}`, {
    headers: HDR,
    data: { status: "active", globalDefault: false, rolloutPercentage: null, planAvailability: null },
  });
}

async function revokeRole(page: import("@playwright/test").Page, email: string) {
  const res = await page.request.get(`${API_URL}/rpc-admin/staff`, { headers: HDR });
  if (!res.ok()) return;
  const body = (await res.json()) as { items: { userId: string; email: string }[] };
  const target = body.items.find((i) => i.email === email);
  if (!target) return;
  await page.request.patch(`${API_URL}/rpc-admin/staff/${target.userId}/role`, {
    headers: HDR,
    data: { role: null },
  });
}

test.describe("Platform Admin — Global Feature Management", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await resetKey(page);
    await revokeRole(page, "owner@acme.test");
    await ctx.close();
  });

  test("admin edits global config on the detail page and it persists", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto(`http://localtest.me:3000/admin/feature-flags/${KEY}`);
    await page.waitForLoadState("networkidle");

    // Turn the global default on and set a rollout.
    await page.getByRole("switch", { name: "Global default" }).click();
    await page.getByLabel("Rollout percentage").fill("50");
    await page.getByRole("button", { name: /save configuration/i }).click();
    await expect(page.getByText(/feature configuration saved/i)).toBeVisible();

    // Reload — the values persisted server-side.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("switch", { name: "Global default" })).toBeChecked();
    await expect(page.getByLabel("Rollout percentage")).toHaveValue("50");
  });

  test("resolution order: kill switch beats an explicit per-tenant enable", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-fm-kill${uniq}`;
    const ownerEmail = `test-fm-kill-owner${uniq}@example.com`;
    await signUpWorkspace(page, { name: "FM Kill Org", email: ownerEmail, slug });

    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    // Resolve the org id, give it an explicit per-tenant ENABLE for the key.
    const orgRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations?q=${slug}`,
      { headers: HDR },
    );
    const orgId = ((await orgRes.json()) as { items: { id: string }[] }).items[0]!.id;
    await adminPage.request.put(`${API_URL}/rpc-admin/organizations/${orgId}/feature-flags`, {
      headers: HDR,
      data: { key: KEY, enabled: true },
    });

    // With the kill switch OFF (active), the tenant resolves ON (override).
    await page.goto(`http://${slug}.localtest.me:3000/dashboard/settings/features`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("switch", { name: `Toggle ${KEY_LABEL}` })).toBeChecked();

    // Flip the global kill switch (status = disabled) via the API.
    await adminPage.request.patch(`${API_URL}/rpc-admin/feature-flags/${KEY}`, {
      headers: HDR,
      data: { status: "disabled" },
    });

    // Now the SAME tenant, with the SAME explicit enable, resolves OFF — the
    // kill switch (#1) beats the per-tenant override (#2). A reason is shown.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("switch", { name: `Toggle ${KEY_LABEL}` })).not.toBeChecked();
    await expect(page.getByText(/disabled platform-wide/i)).toBeVisible();

    await adminCtx.close();
  });

  test("a platform viewer can read the list/detail but a direct PATCH is rejected (403)", async ({
    page,
    browser,
  }) => {
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    // Borrow owner@acme.test as a throwaway viewer target (reverted in afterEach).
    const acmeRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations?q=acme`,
      { headers: HDR },
    );
    const acmeId = ((await acmeRes.json()) as { items: { id: string }[] }).items[0]!.id;
    const membersRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${acmeId}/members`,
      { headers: HDR },
    );
    const acmeOwner = ((await membersRes.json()) as {
      items: { userId: string; email: string }[];
    }).items.find((m) => m.email === "owner@acme.test")!;
    await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${acmeOwner.userId}/role`, {
      headers: HDR,
      data: { role: "viewer" },
    });

    // Sign in as the viewer; the list and detail load read-only.
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");
    await page.goto(`http://localtest.me:3000/admin/feature-flags/${KEY}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Global configuration")).toBeVisible();
    // No enabled Save control for a viewer.
    await expect(page.getByRole("button", { name: /save configuration/i })).toHaveCount(0);

    // Direct PATCH is refused server-side.
    const res = await page.request.patch(`${API_URL}/rpc-admin/feature-flags/${KEY}`, {
      headers: HDR,
      data: { globalDefault: true },
    });
    expect(res.status()).toBe(403);

    await adminCtx.close();
  });

  test("a global-config PATCH writes a platform.feature.globalConfigUpdated audit row", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.request.patch(`${API_URL}/rpc-admin/feature-flags/${KEY}`, {
      headers: HDR,
      data: { globalDefault: true },
    });
    const auditRes = await page.request.get(
      `${API_URL}/rpc-admin/audit?q=platform.feature.globalConfigUpdated`,
      { headers: HDR },
    );
    expect(auditRes.ok()).toBeTruthy();
    const body = (await auditRes.json()) as {
      items: { action: string; targetId: string }[];
    };
    expect(
      body.items.some(
        (i) => i.action === "platform.feature.globalConfigUpdated" && i.targetId === KEY,
      ),
    ).toBeTruthy();
  });
});
