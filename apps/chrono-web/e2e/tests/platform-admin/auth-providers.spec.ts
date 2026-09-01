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

test.describe("Platform Auth Providers", () => {
  test("a platform admin can open the auth providers page", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform@agora.test");
    await page.goto("http://localtest.me:3000/admin/auth-providers");
    await page.waitForLoadState("networkidle");
    expect(page.url()).toContain("/admin/auth-providers");
    
    const apiRes = await page.request.get(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}/rpc-admin/auth-providers`
    );
    expect(apiRes.status()).toBe(200);
  });

  test("a platform viewer can read the sign-in methods (read floor)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform-viewer@agora.test");
    const apiRes = await page.request.get(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}/rpc-admin/auth-providers`
    );
    expect(apiRes.status()).toBe(200);
  });

  test("a tenant owner with no platform role cannot read the sign-in methods", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");
    const apiRes = await page.request.get(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}/rpc-admin/auth-providers`
    );
    expect(apiRes.status()).toBe(403);
  });

  test("a platform viewer cannot change a provider (manage gate)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform-viewer@agora.test");
    const apiRes = await page.request.patch(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}/rpc-admin/auth-providers/google`,
      {
        headers: { "x-platform-admin": "1", "content-type": "application/json" },
        data: { enabled: true }
      }
    );
    expect(apiRes.status()).toBe(403);
  });

  test("a tenant owner cannot change a provider (manage gate)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");
    const apiRes = await page.request.patch(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}/rpc-admin/auth-providers/google`,
      {
        headers: { "x-platform-admin": "1", "content-type": "application/json" },
        data: { enabled: true }
      }
    );
    expect(apiRes.status()).toBe(403);
  });
});
