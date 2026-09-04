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

test.describe("Platform Webhooks", () => {
  test("a platform admin can open the webhooks page", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform@agora.test");
    await page.goto("http://localtest.me:3000/admin/webhooks");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: /webhooks/i })).toBeVisible();
  });

  test("a tenant owner with no platform role cannot read the cross-tenant webhooks list", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");
    const apiRes = await page.request.get(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}/rpc-admin/webhooks`,
    );
    expect(apiRes.status()).toBe(403);
  });

  test("a platform viewer can read but cannot disable an endpoint", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", "platform-viewer@agora.test");
    const getRes = await page.request.get(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}/rpc-admin/webhooks`,
    );
    expect(getRes.status()).toBe(200);

    const postRes = await page.request.post(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}/rpc-admin/webhooks/does-not-exist/disable`,
      {
        headers: { "x-platform-admin": "1" },
      },
    );
    expect(postRes.status()).toBe(403);
  });

  test("a tenant owner cannot retry a delivery (permission gate)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");
    const apiRes = await page.request.post(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}/rpc-admin/webhooks/does-not-exist/deliveries/none/retry`,
      {
        headers: { "x-platform-admin": "1" },
      },
    );
    expect(apiRes.status()).toBe(403);
  });
});
