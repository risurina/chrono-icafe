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
const host = "localtest.me:3000";

test.describe("Platform Integrations — reauthorize", () => {
  test("an admin reauthorizes a category and the connection resets to disconnected", async ({ page }) => {
    await signInStaff(page, host, "platform@agora.test");
    const res = await page.request.patch(`${API}/rpc-admin/integrations/analytics`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { action: "reauthorize" },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.connectionStatus).toBe("disconnected");
    expect(body.lastTestError).toBeNull();
    
    const get = await page.request.get(`${API}/rpc-admin/integrations/analytics`, {
      headers: { "x-platform-admin": "1" },
    });
    const getBody = await get.json();
    expect(getBody.connectionStatus).toBe("disconnected");
  });

  test("a viewer cannot reauthorize (manage gate)", async ({ page }) => {
    await signInStaff(page, host, "platform-viewer@agora.test");
    const res = await page.request.patch(`${API}/rpc-admin/integrations/analytics`, {
      headers: { "x-platform-admin": "1", "content-type": "application/json" },
      data: { action: "reauthorize" },
    });
    expect(res.status()).toBe(403);
  });

  test("reauthorize without the CSRF header is rejected", async ({ page }) => {
    await signInStaff(page, host, "platform@agora.test");
    const res = await page.request.patch(`${API}/rpc-admin/integrations/analytics`, {
      headers: { "content-type": "application/json" },
      data: { action: "reauthorize" },
    });
    expect(res.status()).toBe(400);
  });
});
