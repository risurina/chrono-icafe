import { test, expect } from "@playwright/test";

const SEEDED_PASSWORD = "Password123!";
const GLOBAL_CUSTOMER_EMAIL = "global@customer.test";

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

test.describe("Platform Global Customers Management", () => {
  test("a platform admin can open the global customers page", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform@agora.test");
    await page.goto("http://localtest.me:3000/admin/global-customers");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: /global customers/i })).toBeVisible();
    await expect(page.getByText(GLOBAL_CUSTOMER_EMAIL)).toBeVisible();
  });

  test("a platform viewer can read the global customers list (read floor)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform-viewer@agora.test");
    const res = await page.request.get(`${API}/rpc-admin/global-customers`);
    expect(res.status()).toBe(200);
  });

  test("a tenant owner with no platform role cannot read the global customers list", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", "owner@acme.test");
    const res = await page.request.get(`${API}/rpc-admin/global-customers`);
    expect(res.status()).toBe(403);
  });

  test("a platform viewer cannot suspend a global customer (disable gate)", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform-viewer@agora.test");
    const list = await page.request.get(`${API}/rpc-admin/global-customers?q=global@customer`);
    const body = await list.json();
    const customerId = body.items?.[0]?.id;
    expect(customerId).toBeTruthy();

    const res = await page.request.post(
      `${API}/rpc-admin/global-customers/${customerId}/suspend`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(res.status()).toBe(403);
  });

  test("a platform admin can suspend then reactivate a global customer", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", "platform@agora.test");
    const list = await page.request.get(`${API}/rpc-admin/global-customers?q=global@customer`);
    const body = await list.json();
    const customerId = body.items?.[0]?.id;
    expect(customerId).toBeTruthy();

    const suspend = await page.request.post(
      `${API}/rpc-admin/global-customers/${customerId}/suspend`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(suspend.status()).toBe(200);

    const detail = await page.request.get(`${API}/rpc-admin/global-customers/${customerId}`);
    const detailBody = await detail.json();
    expect(detailBody.status).toBe("suspended");

    const reactivate = await page.request.post(
      `${API}/rpc-admin/global-customers/${customerId}/reactivate`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(reactivate.status()).toBe(200);

    const detailAfter = await page.request.get(`${API}/rpc-admin/global-customers/${customerId}`);
    const detailAfterBody = await detailAfter.json();
    expect(detailAfterBody.status).toBe("active");
  });
});
