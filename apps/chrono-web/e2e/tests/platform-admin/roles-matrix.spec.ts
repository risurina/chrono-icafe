import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the read-only Roles & permissions matrix
 * (`/admin/roles`, `GET /rpc-admin/roles`). The platform-admin RBAC is
 * code-defined (`PLATFORM_ROLES` × `PLATFORM_PERMISSION_STATEMENTS`), so this
 * page only VISUALIZES it — there is no editor, and the one real mutation
 * (assigning a role) lives at `/admin/staff`, which the page links to.
 *
 * The route is gated on `staff:read`, which every platform role holds, so both
 * the seeded admin (`platform@agora.test`) and the seeded viewer
 * (`platform-viewer@agora.test`) can view it; a tenant owner with no platform
 * role is blocked at the API. Same conventions as `staff.spec.ts` /
 * `billing.spec.ts` — real dev DB, no destructive writes (this surface has
 * none). This has no tenant dimension, so there is no cross-tenant-isolation
 * case (mirrors the audit-log specs).
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const PLATFORM_VIEWER_EMAIL = "platform-viewer@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

async function signInStaff(
  page: import("@playwright/test").Page,
  email: string,
) {
  await page.goto("http://localtest.me:3000/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

test.describe("Platform Roles & Permissions matrix", () => {
  test("a platform admin sees the three code roles, the matrix, and the aspirational role — read-only", async ({
    page,
  }) => {
    await signInStaff(page, PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/roles");
    await page.waitForLoadState("networkidle");

    // The three real, code-defined role cards.
    await expect(page.getByText("Platform Admin (full access)")).toBeVisible();
    await expect(page.getByText("Support Agent")).toBeVisible();
    await expect(page.getByText("Auditor / read-only")).toBeVisible();

    // The permission matrix and the group mapping both render.
    await expect(
      page.getByRole("heading", { name: /permission matrix/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /permission groups/i }),
    ).toBeVisible();

    // The spec's Billing Administrator is shown as explicitly aspirational,
    // never as a real grant.
    await expect(page.getByText("Billing Administrator")).toBeVisible();
    await expect(page.getByText("aspirational").first()).toBeVisible();

    // The only mutating affordance is a LINK out to /admin/staff — there is no
    // in-page role editor.
    const manage = page.getByRole("link", { name: /manage assignments/i }).first();
    await expect(manage).toBeVisible();
    await expect(manage).toHaveAttribute("href", "/admin/staff");
    // No form controls that would let a user edit a role in place.
    await expect(page.getByRole("textbox")).toHaveCount(0);
  });

  test("a platform viewer can view the read-only matrix (staff:read)", async ({
    page,
  }) => {
    await signInStaff(page, PLATFORM_VIEWER_EMAIL);
    await page.goto("http://localtest.me:3000/admin/roles");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Platform Admin (full access)")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: /permission matrix/i }),
    ).toBeVisible();
    // Still read-only for a viewer — the matrix links out, never edits.
    await expect(page.getByRole("textbox")).toHaveCount(0);

    // The gated API returns 200 for a viewer.
    const apiRes = await page.request.get(`${API_URL}/rpc-admin/roles`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(apiRes.status()).toBe(200);
    const body = await apiRes.json();
    expect(Array.isArray(body.roles)).toBe(true);
    expect(body.roles.length).toBe(3);
  });

  test("a tenant owner with no platform role is blocked from the roles matrix API (403)", async ({
    page,
  }) => {
    await page.goto("http://localtest.me:3000/login");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill("owner@acme.test");
    await page.getByLabel("Password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 15_000,
    });

    const apiRes = await page.request.get(`${API_URL}/rpc-admin/roles`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(apiRes.status()).toBe(403);
  });
});
