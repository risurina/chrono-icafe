import { test, expect } from "@playwright/test";

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

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

test.describe("Platform Administrators Management", () => {
  test("a platform admin can open the administrators (staff) page", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform@agora.test");
    await page.goto("http://localtest.me:3000/admin/staff");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: /staff|administrators/i })).toBeVisible();
  });

  test("a platform viewer can read the administrators list (read floor)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform-viewer@agora.test");
    const res = await page.request.get(`${API}/rpc-admin/staff`);
    expect(res.status()).toBe(200);
  });

  test("a tenant owner with no platform role cannot read the administrators list", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");
    const res = await page.request.get(`${API}/rpc-admin/staff`);
    expect(res.status()).toBe(403);
  });

  test("a platform viewer cannot invite an administrator (manage gate)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform-viewer@agora.test");
    const res = await page.request.post(`${API}/rpc-admin/staff/invite`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { email: `e2e-noop-${Date.now()}@agora.test`, name: "E2E Noop", role: "viewer" }
    });
    expect(res.status()).toBe(403);
  });

  test("a tenant owner cannot invite an administrator (manage gate)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");
    const res = await page.request.post(`${API}/rpc-admin/staff/invite`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { email: `e2e-noop2-${Date.now()}@agora.test`, name: "E2E Noop2", role: "viewer" }
    });
    expect(res.status()).toBe(403);
  });
});
