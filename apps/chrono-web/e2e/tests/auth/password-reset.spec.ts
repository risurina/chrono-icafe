import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the user-facing password-reset REQUEST flow (staff).
 *
 * The full invite → accept → member, and forgot → reset → sign-in flows are
 * covered end-to-end by the API-level suite (`pnpm test:e2e`), which can read
 * the console email driver's link to recover the single-use token — something a
 * browser can't reach. Here we assert the tenant-branded request UI itself:
 * the "Forgot password?" entry point and the enumeration-safe confirmation.
 */
test.describe("Password reset request", () => {
  test("staff can request a reset link from the tenant login page", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slug = `e2e${uniq}`;
    const email = `pw${uniq}@example.com`;

    // Create a business so we're on a real tenant subdomain.
    await page.goto("/sign-up");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await page.getByLabel("Your name").fill("PW Tester");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByLabel("Business name").fill(slug);
    await page.getByRole("button", { name: /create business/i }).click();
    await page.waitForURL(
      new RegExp(`//${slug}\\.localtest\\.me:3000/admin`),
      { timeout: 60_000 },
    );

    // From the tenant login, follow "Forgot password?" to the request form.
    await page.goto(`http://${slug}.localtest.me:3000/admin/login`);
    await page.getByRole("link", { name: /forgot password/i }).click();
    await page.waitForURL(/\/forgot-password$/);

    // Submit the request; the confirmation is enumeration-safe (never reveals
    // whether the account exists).
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: /send reset link/i }).click();
    await expect(page.getByText(/a reset link is on its way/i)).toBeVisible();
  });
});
