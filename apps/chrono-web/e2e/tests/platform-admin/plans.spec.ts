import { test, expect } from "@playwright/test";

const SEEDED_PASSWORD = "Password123!";
const HOST = "localtest.me:3000";
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

test.describe("Platform Subscription Plans", () => {
  test("a platform admin can open the plans catalog page", async ({ page }) => {
    await signInStaff(page, HOST, "platform@agora.test");
    await page.goto(`http://${HOST}/admin/plans`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: /plans/i })).toBeVisible();
  });

  test("a platform viewer can read the plan catalog (read floor)", async ({ page }) => {
    await signInStaff(page, HOST, "platform-viewer@agora.test");
    const res = await page.request.get(`${API}/rpc-admin/plans`);
    expect(res.status()).toBe(200);
  });

  test("a tenant owner with no platform role cannot read the plan catalog", async ({ page }) => {
    await signInStaff(page, HOST, "owner@acme.test");
    const res = await page.request.get(`${API}/rpc-admin/plans`);
    expect(res.status()).toBe(403);
  });

  test("a platform viewer cannot archive a plan (manage gate)", async ({ page }) => {
    await signInStaff(page, HOST, "platform-viewer@agora.test");
    const res = await page.request.post(`${API}/rpc-admin/plans/pro/archive`, {
      headers: { "x-platform-admin": "1" }
    });
    expect(res.status()).toBe(403);
  });

  test("a tenant owner cannot archive a plan (manage gate)", async ({ page }) => {
    await signInStaff(page, HOST, "owner@acme.test");
    const res = await page.request.post(`${API}/rpc-admin/plans/pro/archive`, {
      headers: { "x-platform-admin": "1" }
    });
    expect(res.status()).toBe(403);
  });
});
