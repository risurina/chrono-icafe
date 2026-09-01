import { test, expect } from "@playwright/test";

const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const PLATFORM_VIEWER_EMAIL = "platform-viewer@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

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
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

test.describe("Platform API Keys", () => {
  test("a platform admin can open the API keys page", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/api-keys");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: /api keys/i })
    ).toBeVisible();
  });

  test("a tenant owner with no platform role cannot read the cross-tenant API keys list", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");

    const res = await page.request.get(`${API}/rpc-admin/api-keys`);
    expect(res.status()).toBe(403);
  });

  test("a platform viewer can read the list but cannot revoke a key", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_VIEWER_EMAIL);

    const getRes = await page.request.get(`${API}/rpc-admin/api-keys`);
    expect(getRes.status()).toBe(200);

    const postRes = await page.request.post(
      `${API}/rpc-admin/api-keys/does-not-exist/revoke`,
      {
        headers: { "x-platform-admin": "1" },
      }
    );
    expect(postRes.status()).toBe(403);
  });

  test("a tenant owner cannot rotate a key (permission gate)", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");

    const postRes = await page.request.post(
      `${API}/rpc-admin/api-keys/does-not-exist/rotate`,
      {
        headers: { "x-platform-admin": "1" },
      }
    );
    expect(postRes.status()).toBe(403);
  });
});
