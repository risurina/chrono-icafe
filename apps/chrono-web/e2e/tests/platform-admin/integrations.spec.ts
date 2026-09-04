import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the platform admin integrations surface:
 * `GET`/`PATCH /rpc-admin/integrations[/:category]` +
 * `POST /rpc-admin/integrations/:category/test`, rendered at
 * `/admin/integrations` (list) and `/admin/integrations/[category]` (detail).
 *
 * Covers the happy path (an admin edits non-secret config and it persists),
 * the test-connection contract (a real pass/fail, never a fabricated status),
 * the role gate (a viewer sees no mutating controls and a direct PATCH/POST is
 * rejected 403), the CSRF-preflight header guard, and the secrets rule (a
 * stored secret is never returned by any read).
 *
 * Platform integrations are platform-GLOBAL (no per-tenant dimension), so no
 * throwaway orgs are needed — unlike per-org surfaces. This suite runs headed
 * against the real dev DB (`pnpm dev` must be running); it borrows the seeded
 * `owner@acme.test` account as a throwaway platform-viewer target and reverts
 * it in afterEach, the same pattern as `feature-flags.spec.ts`.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

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
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
    timeout: 15_000,
  });
}

async function revokeRole(page: import("@playwright/test").Page, email: string) {
  const res = await page.request.get(`${API_URL}/rpc-admin/staff`, {
    headers: { "x-platform-admin": "1" },
  });
  if (!res.ok()) return;
  const body = (await res.json()) as { items: { userId: string; email: string }[] };
  const target = body.items.find((i) => i.email === email);
  if (!target) return;
  await page.request.patch(`${API_URL}/rpc-admin/staff/${target.userId}/role`, {
    headers: { "x-platform-admin": "1" },
    data: { role: null },
  });
}

test.describe("Platform Admin — Integrations", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    // Reset any config/secret we set, and revert the borrowed viewer grant.
    await page.request.patch(`${API_URL}/rpc-admin/integrations/monitoring`, {
      headers: { "x-platform-admin": "1" },
      data: { action: "configure", config: { environment: "", release: "" } },
    });
    await page.request.patch(`${API_URL}/rpc-admin/integrations/sms`, {
      headers: { "x-platform-admin": "1" },
      data: { clearSecret: true },
    });
    await revokeRole(page, "owner@acme.test");
    await ctx.close();
  });

  test("an admin edits non-secret config and it persists; a test reflects a real result", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    await page.goto("http://localtest.me:3000/admin/integrations/monitoring");
    await page.waitForLoadState("networkidle");

    await page.getByLabel(/Environment/i).fill("production");
    await page.getByRole("button", { name: /save configuration/i }).click();
    await expect(page.getByText(/configuration saved/i)).toBeVisible();

    // Persisted server-side, not just optimistic UI.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByLabel(/Environment/i)).toHaveValue("production");

    // Test-connection on a testable category (payment) reflects a REAL result.
    await page.goto("http://localtest.me:3000/admin/integrations/payment");
    await page.waitForLoadState("networkidle");
    const testRes = await page.request.post(
      `${API_URL}/rpc-admin/integrations/payment/test`,
      { headers: { "x-platform-admin": "1" }, data: {} },
    );
    expect(testRes.ok()).toBeTruthy();
    const testBody = (await testRes.json()) as {
      testable: boolean;
      ok: boolean;
      connectionStatus: string;
    };
    // Whatever the dev env's Stripe key state, the status is the real probe
    // result — never fabricated. testable is true for payment.
    expect(testBody.testable).toBe(true);
    expect(["connected", "error"]).toContain(testBody.connectionStatus);
  });

  test("a stored secret is never returned by any read", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const SECRET = `sms-secret-${Date.now()}`;

    const patch = await page.request.patch(
      `${API_URL}/rpc-admin/integrations/sms`,
      {
        headers: { "x-platform-admin": "1" },
        data: { action: "configure", secret: SECRET, config: { senderId: "Agora" } },
      },
    );
    expect(patch.ok()).toBeTruthy();
    const patchBody = await patch.json();
    expect(patchBody.hasStoredSecret).toBe(true);
    expect(JSON.stringify(patchBody)).not.toContain(SECRET);

    const get = await page.request.get(`${API_URL}/rpc-admin/integrations/sms`, {
      headers: { "x-platform-admin": "1" },
    });
    const getBody = await get.json();
    expect(getBody.hasStoredSecret).toBe(true);
    expect(JSON.stringify(getBody)).not.toContain(SECRET);

    // The detail page shows "stored", never the value.
    await page.goto("http://localtest.me:3000/admin/integrations/sms");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/stored/i).first()).toBeVisible();
    await expect(page.getByText(SECRET)).toHaveCount(0);
  });

  test("a platform viewer sees no mutating controls, and direct PATCH/POST are rejected (403)", async ({
    page,
    browser,
  }) => {
    // Grant owner@acme.test the viewer platform role (reverted in afterEach).
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const staffRes = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, {
      headers: { "x-platform-admin": "1" },
    });
    const staffBody = (await staffRes.json()) as {
      items: { userId: string; email: string }[];
    };
    let target = staffBody.items.find((i) => i.email === "owner@acme.test");
    if (!target) {
      const acmeOrgRes = await adminPage.request.get(
        `${API_URL}/rpc-admin/organizations?search=acme`,
        { headers: { "x-platform-admin": "1" } },
      );
      const acmeOrg = (await acmeOrgRes.json()) as { items: { id: string }[] };
      const membersRes = await adminPage.request.get(
        `${API_URL}/rpc-admin/organizations/${acmeOrg.items[0]!.id}/members`,
        { headers: { "x-platform-admin": "1" } },
      );
      const members = (await membersRes.json()) as {
        items: { userId: string; email: string }[];
      };
      target = members.items.find((m) => m.email === "owner@acme.test");
    }
    expect(target).toBeTruthy();
    await adminPage.request.patch(
      `${API_URL}/rpc-admin/staff/${target!.userId}/role`,
      { headers: { "x-platform-admin": "1" }, data: { role: "viewer" } },
    );
    await adminCtx.close();

    // Sign in as the viewer.
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");
    await page.goto("http://localtest.me:3000/admin/integrations/monitoring");
    await page.waitForLoadState("networkidle");
    // No mutating control is rendered for a viewer.
    await expect(
      page.getByRole("button", { name: /save configuration/i }),
    ).toHaveCount(0);

    // The client-side hiding is not a security boundary — the direct calls 403.
    const patch = await page.request.patch(
      `${API_URL}/rpc-admin/integrations/monitoring`,
      {
        headers: { "x-platform-admin": "1" },
        data: { action: "configure", config: { environment: "prod" } },
      },
    );
    expect(patch.status()).toBe(403);
    const testPost = await page.request.post(
      `${API_URL}/rpc-admin/integrations/payment/test`,
      { headers: { "x-platform-admin": "1" }, data: {} },
    );
    expect(testPost.status()).toBe(403);
  });

  test("a PATCH without the x-platform-admin CSRF-preflight header is rejected (400)", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const res = await page.request.patch(
      `${API_URL}/rpc-admin/integrations/monitoring`,
      { data: { action: "configure", config: { environment: "prod" } } },
    );
    expect(res.status()).toBe(400);
  });
});
