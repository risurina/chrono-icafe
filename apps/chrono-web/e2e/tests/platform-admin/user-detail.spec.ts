import { test, expect } from "@playwright/test";

const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const PLATFORM_VIEWER_EMAIL = "platform-viewer@agora.test";
const TENANT_OWNER_EMAIL = "owner@acme.test";
const SEEDED_PASSWORD = "Password123!";

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

test.describe("Platform User Detail", () => {
  const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

  test("a platform admin opens a user detail page and sees the tabs", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const list = await page.request.get(`${API}/rpc-admin/users?pageSize=1`);
    expect(list.status()).toBe(200);
    const id = (await list.json()).items[0].id;
    await page.goto(`http://localtest.me:3000/admin/users/${id}`);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(new RegExp(id));

    const tabs = [
      "Profile",
      "Organizations",
      "Sessions",
      "Security events",
      "Activity",
      "Audit history",
    ];
    for (const tabName of tabs) {
      await expect(page.getByRole("tab", { name: tabName })).toBeVisible();
    }
  });

  test("switching to the Sessions tab shows its panel", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const list = await page.request.get(`${API}/rpc-admin/users?pageSize=1`);
    expect(list.status()).toBe(200);
    const id = (await list.json()).items[0].id;
    await page.goto(`http://localtest.me:3000/admin/users/${id}`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("tab", { name: "Sessions" }).click();
    await expect(page.getByRole("heading", { name: /^sessions$/i })).toBeVisible();
  });

  test("a platform viewer can read the user directory and a detail (read floor)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_VIEWER_EMAIL);
    const res = await page.request.get(`${API}/rpc-admin/users`);
    expect(res.status()).toBe(200);
    const id = (await res.json()).items[0].id;
    const d = await page.request.get(`${API}/rpc-admin/users/${id}`);
    expect(d.status()).toBe(200);
  });

  test("a tenant owner with no platform role is denied the user detail read", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", TENANT_OWNER_EMAIL);
    const res = await page.request.get(`${API}/rpc-admin/users/any-nonexistent-id`);
    expect(res.status()).toBe(403);
  });

  test("a tenant owner cannot ban a user (permission gate reached past validation)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", TENANT_OWNER_EMAIL);
    const res = await page.request.patch(`${API}/rpc-admin/users/does-not-exist/ban`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { banReason: "blocked" },
    });
    expect(res.status()).toBe(403);
  });
});
