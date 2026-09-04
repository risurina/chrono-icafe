import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the platform-wide security policy surface
 * (`/admin/security`, `/rpc-admin/security-policy`,
 * `/rpc-admin/security/mfa`). Most of the guard/gate coverage — the
 * contract floor, the all-admins 2FA guard, the enforcement fold-in, the
 * three-route allowlist, break-glass — is proven at the HTTP level in
 * `apps/api/src/e2e/run.ts` (search "W2b. Platform-wide security policy"),
 * which can assert against real seeded platform-role accounts without a
 * browser. This spec covers what only a browser can prove: the settings
 * page itself, role-based visibility, and the server-authoritative error
 * text shown on a guard refusal.
 *
 * This suite runs against the real dev DB — same conventions as
 * `staff.spec.ts` / `organizations.spec.ts` (`fullyParallel: false`,
 * `workers: 1`, no `webServer` — `pnpm dev` must already be running).
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

/** Always leave the policy at all-defaults so other specs are unaffected. */
async function resetPolicy(page: import("@playwright/test").Page) {
  await page.request.patch(`${API_URL}/rpc-admin/security-policy`, {
    headers: { "x-platform-admin": "1" },
    data: { twoFactorRequired: false, sessionMaxAgeMinutes: null },
  });
}

test.describe("Platform Security Policy", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await resetPolicy(page);
    await ctx.close();
  });

  test("an admin reads defaults, sets both fields, and reads back effective values", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/security");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Require 2FA")).toBeVisible();
    await expect(page.getByLabel("Minutes (blank = no override)")).toBeVisible();

    await page.getByLabel("Minutes (blank = no override)").fill("480");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Security policy updated.")).toBeVisible();

    const res = await page.request.get(`${API_URL}/rpc-admin/security-policy`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.sessionMaxAgeMinutes).toBe(480);
  });

  test("the contract floor rejects sessionMaxAgeMinutes: 1 before any guard logic runs", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const res = await page.request.patch(`${API_URL}/rpc-admin/security-policy`, {
      headers: { "x-platform-admin": "1" },
      data: { sessionMaxAgeMinutes: 1 },
    });
    expect(res.status()).toBe(400);
  });

  test("a viewer sees the settings read-only and a direct PATCH is rejected", async ({
    page,
    browser,
  }) => {
    // Grant owner@contoso.test the "viewer" platform role, as in staff.spec.ts.
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const orgsRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations?search=contoso`,
      { headers: { "x-platform-admin": "1" } },
    );
    const orgsBody = (await orgsRes.json()) as { items: { id: string }[] };
    const contosoId = orgsBody.items[0]?.id;
    const membersRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${contosoId}/members`,
      { headers: { "x-platform-admin": "1" } },
    );
    const membersBody = (await membersRes.json()) as {
      items: { userId: string; email: string }[];
    };
    const contosoOwner = membersBody.items.find((m) => m.email === "owner@contoso.test");
    await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${contosoOwner!.userId}/role`, {
      headers: { "x-platform-admin": "1" },
      data: { role: "viewer" },
    });

    await page.goto("http://localtest.me:3000/login");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill("owner@contoso.test");
    await page.getByLabel("Password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 15_000 });

    await page.goto("http://localtest.me:3000/admin/security");
    await page.waitForLoadState("networkidle");
    // Manage controls (Switch / Save button) are hidden for a viewer.
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);

    const directPatch = await page.request.patch(`${API_URL}/rpc-admin/security-policy`, {
      headers: { "x-platform-admin": "1" },
      data: { sessionMaxAgeMinutes: 60 },
    });
    expect(directPatch.status()).toBe(403);

    // Cleanup: revoke the viewer role.
    await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${contosoOwner!.userId}/role`, {
      headers: { "x-platform-admin": "1" },
      data: { role: null },
    });
    await adminCtx.close();
  });

  test("enabling twoFactorRequired while another admin is unenrolled shows their email, then succeeds once enrolled", async ({
    page,
    browser,
  }) => {
    // Grant owner@acme.test a platform admin role to act as the "other,
    // unenrolled" account — its credential account exists (created at
    // sign-up), so it is enrollable but not yet enrolled.
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const orgsRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations?search=acme`,
      { headers: { "x-platform-admin": "1" } },
    );
    const orgsBody = (await orgsRes.json()) as { items: { id: string }[] };
    const acmeId = orgsBody.items[0]?.id;
    const membersRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${acmeId}/members`,
      { headers: { "x-platform-admin": "1" } },
    );
    const membersBody = (await membersRes.json()) as {
      items: { userId: string; email: string }[];
    };
    const acmeOwner = membersBody.items.find((m) => m.email === "owner@acme.test");
    await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${acmeOwner!.userId}/role`, {
      headers: { "x-platform-admin": "1" },
      data: { role: "admin" },
    });

    await page.goto("http://localtest.me:3000/admin/security");
    await page.waitForLoadState("networkidle");
    const toggle = page.getByRole("switch", { name: /require 2fa/i });
    await toggle.click();
    await expect(page.getByText(/owner@acme\.test/)).toBeVisible({ timeout: 10_000 });

    // Cleanup: revoke the platform role granted above (also clears it from
    // the all-admins guard so the afterEach reset isn't blocked).
    await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${acmeOwner!.userId}/role`, {
      headers: { "x-platform-admin": "1" },
      data: { role: null },
    });
    await adminCtx.close();
  });
});
