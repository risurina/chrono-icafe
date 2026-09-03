import { test, expect } from "@playwright/test";

test.describe("Sign-up onboarding", () => {
  test("creates a business and lands on the tenant dashboard", async ({ page }) => {
    const uniq = Date.now();
    const slug = `e2e${uniq}`;
    const email = `pw${uniq}@example.com`;

    await page.goto("/sign-up");
    // Wait for the client bundle to hydrate so the form's onSubmit
    // (preventDefault + JS handler) is attached — otherwise a fast click submits
    // the form natively as a GET.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.getByLabel("Your name").fill("PW Tester");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByLabel("Business name").fill(slug); // slug auto-derives

    await page.getByRole("button", { name: /create business/i }).click();

    // Redirects to {slug}.localtest.me:3000/dashboard on success.
    await page.waitForURL(
      new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`),
      { timeout: 60_000 },
    );

    // Dashboard shell rendered (not bounced to /login) → session works
    // cross-subdomain.
    await expect(page).toHaveURL(/\/dashboard$/);
    // Dashboard shell rendered: the sidebar nav is present.
    await expect(page.getByRole("link", { name: "Projects" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Settings" }),
    ).toBeVisible();
  });
});
