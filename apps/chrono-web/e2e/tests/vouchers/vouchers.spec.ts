import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

const SEEDED_PASSWORD = "Password123!";

async function signUp(
  page: import("@playwright/test").Page,
  { name, email, slug }: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

test.describe("Vouchers", () => {
  test("happy path: issue voucher, confirm active, cancel second voucher, confirm status updates", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2evoucher${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const code1 = faker.string.alphanumeric(8).toUpperCase();
    const code2 = faker.string.alphanumeric(8).toUpperCase();

    // 1. Owner signs up the business
    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // 2. Navigate to Vouchers page
    await page.goto(`${base}/dashboard/vouchers`);
    await page.waitForLoadState("networkidle");

    // 3. Issue first voucher
    await page.getByRole("button", { name: "Issue Voucher" }).click();
    await page.getByLabel("Discount Type").click();
    await page.getByRole("option", { name: "Fixed Amount" }).click();
    await page.getByLabel("Discount Value").fill("10.00");
    await page.getByLabel("Code (optional)").fill(code1);
    await page.getByRole("button", { name: "Issue" }).click();

    // Verify toast and presence in list
    await expect(page.getByText("Voucher issued.")).toBeVisible();

    // We expect the row to have the code, the discount, and the status "Active"
    const row1 = page.locator("tr").filter({ hasText: code1 });
    await expect(row1).toBeVisible();
    await expect(row1.getByText("10.00")).toBeVisible();
    await expect(row1.getByText("active", { exact: true })).toBeVisible();

    // 4. Issue second voucher
    await page.getByRole("button", { name: "Issue Voucher" }).click();
    await page.getByLabel("Discount Type").click();
    await page.getByRole("option", { name: "Percentage" }).click();
    await page.getByLabel("Discount Value").fill("15");
    await page.getByLabel("Code (optional)").fill(code2);
    await page.getByRole("button", { name: "Issue" }).click();

    await expect(page.getByText("Voucher issued.")).toBeVisible();

    const row2 = page.locator("tr").filter({ hasText: code2 });
    await expect(row2).toBeVisible();
    await expect(row2.getByText("15%")).toBeVisible();
    await expect(row2.getByText("active", { exact: true })).toBeVisible();

    // 5. Cancel the second voucher
    await row2.getByRole("button", { name: "Cancel" }).click();
    await page.getByLabel("Reason (optional)").fill("Mistake");
    await page.getByRole("button", { name: "Cancel Voucher" }).click();

    await expect(page.getByText("Voucher cancelled.")).toBeVisible();

    // Verify status changed to cancelled
    await expect(row2.getByText("cancelled", { exact: true })).toBeVisible();
    // The "Cancel" button should no longer be visible for a cancelled voucher
    await expect(row2.getByRole("button", { name: "Cancel" })).toHaveCount(0);
  });

  test("role gate: unauthenticated request to /rpc/vouchers is refused", async ({
    request,
  }) => {
    // Unauthenticated GET request directly to the API endpoint
    // It should be refused since it requires a cookie/tenant membership context
    const res = await request.get(`http://localtest.me:3000/api/rpc/vouchers`);
    // Expected 401 Unauthorized or similar refusal because tenant is not resolved
    expect(res.status()).toBe(401);
  });

  test("tenant isolation: tenant A's voucher code invisible from tenant B's list, direct cross-tenant GET /:id returns 404", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2evouchera${uniq}`;
    const slugB = `e2evoucherb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;
    const isolatedCode = faker.string.alphanumeric(8).toUpperCase();

    // Tenant A
    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });

    // Tenant A issues a voucher
    await page.goto(`${baseA}/dashboard/vouchers`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Issue Voucher" }).click();
    await page.getByLabel("Discount Type").click();
    await page.getByRole("option", { name: "Fixed Amount" }).click();
    await page.getByLabel("Discount Value").fill("20.00");
    await page.getByLabel("Code (optional)").fill(isolatedCode);
    await page.getByRole("button", { name: "Issue" }).click();

    await expect(page.getByText("Voucher issued.")).toBeVisible();

    // We need to fetch the voucher ID for the direct GET test.
    // We can do an API request on behalf of Tenant A via the page context
    const listRes = await page.request.get(`${baseA}/api/rpc/vouchers`, {
      params: { code: isolatedCode },
    });
    expect(listRes.ok()).toBeTruthy();
    const listBody = (await listRes.json()) as { items: { id: string; code: string }[] };
    const voucherA = listBody.items.find((v) => v.code === isolatedCode);
    expect(voucherA).toBeDefined();
    const voucherIdA = voucherA!.id;

    // Tenant B
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });

    // Verify Tenant B doesn't see Tenant A's voucher in list
    await pageB.goto(`${baseB}/dashboard/vouchers`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(isolatedCode)).toHaveCount(0);

    // Try direct cross-tenant GET /:id
    const crossRes = await pageB.request.get(
      `${baseB}/api/rpc/vouchers/${voucherIdA}`
    );
    // Tenant isolation should prevent finding it and return 404
    expect(crossRes.status()).toBe(404);

    await ctxB.close();
  });
});
