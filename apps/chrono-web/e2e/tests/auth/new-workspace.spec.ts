import { test, expect } from "@playwright/test";

test.describe("New business for an authenticated user", () => {
  test("creates a second business without re-entering credentials", async ({
    page,
  }) => {
    const uniq = Date.now();
    const firstSlug = `e2e${uniq}a`;
    const secondSlug = `e2e${uniq}b`;
    const email = `pw${uniq}@example.com`;

    // Sign up and create the first business.
    await page.goto("/sign-up");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.getByLabel("Your name").fill("PW Tester");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByLabel("Business name").fill(firstSlug);
    await page.getByRole("button", { name: /create business/i }).click();

    await page.waitForURL(
      new RegExp(`//${firstSlug}\\.localtest\\.me:3000/admin`),
      { timeout: 60_000 },
    );

    // Visit the dedicated new-business page while authenticated.
    await page.goto("http://localtest.me:3000/new-business");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    // Only the business fields render — no credential inputs.
    await expect(page.getByLabel("Email")).toHaveCount(0);
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Your name")).toHaveCount(0);
    await expect(page.getByLabel("Business name")).toBeVisible();

    await page.getByLabel("Business name").fill(secondSlug);
    await page.getByRole("button", { name: /create business/i }).click();

    // Redirects to the new tenant's dashboard.
    await page.waitForURL(
      new RegExp(`//${secondSlug}\\.localtest\\.me:3000/admin`),
      { timeout: 60_000 },
    );
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("link", { name: "Projects" })).toBeVisible();

    // Original business is unaffected — switching back still works.
    await page.goto(
      `http://${firstSlug}.localtest.me:3000/admin`,
    );
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("link", { name: "Projects" })).toBeVisible();
  });
});
