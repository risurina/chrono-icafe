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
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

test.describe("Platform Announcements Delivery", () => {
  test("an admin sends an email announcement and re-sending is rejected", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform@agora.test");
    
    const c = await page.request.post(`${API}/rpc-admin/announcements`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { message: `E2E-SEND-${Date.now()}`, severity: "info", channels: ["in_app", "email"] }
    });
    expect(c.ok()).toBeTruthy();
    const id = (await c.json()).id;

    const s = await page.request.post(`${API}/rpc-admin/announcements/${id}/send`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { confirm: true }
    });
    expect(s.status()).toBe(200);

    const resend = await page.request.post(`${API}/rpc-admin/announcements/${id}/send`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { confirm: true }
    });
    expect(resend.status()).toBe(400);

    await page.request.delete(`${API}/rpc-admin/announcements/${id}`, {
      headers: { "x-platform-admin": "1" }
    });
  });

  test("sending an announcement without the email channel is rejected", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform@agora.test");
    
    const c = await page.request.post(`${API}/rpc-admin/announcements`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { message: `E2E-SEND-${Date.now()}`, severity: "info", channels: ["in_app"] }
    });
    expect(c.ok()).toBeTruthy();
    const id = (await c.json()).id;

    const s = await page.request.post(`${API}/rpc-admin/announcements/${id}/send`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { confirm: true }
    });
    expect(s.status()).toBe(400);

    await page.request.delete(`${API}/rpc-admin/announcements/${id}`, {
      headers: { "x-platform-admin": "1" }
    });
  });

  test("a platform viewer cannot send an announcement (manage gate)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform-viewer@agora.test");
    
    const res = await page.request.post(`${API}/rpc-admin/announcements/does-not-exist/send`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { confirm: true }
    });
    expect(res.status()).toBe(403);
  });

  test("a tenant owner cannot send an announcement (manage gate)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");
    
    const res = await page.request.post(`${API}/rpc-admin/announcements/does-not-exist/send`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { confirm: true }
    });
    expect(res.status()).toBe(403);
  });

  test("a tenant owner cannot read announcement delivery stats (read gate)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");
    
    const res = await page.request.get(`${API}/rpc-admin/announcements/does-not-exist/stats`);
    expect(res.status()).toBe(403);
  });
});
