import { test, expect } from "@playwright/test";

test.describe("New workspace for an authenticated user", () => {
  test("creates a second workspace without re-entering credentials", async ({
    page,
  }) => {
    const uniq = Date.now();
    const firstSlug = `e2e${uniq}a`;
    const secondSlug = `e2e${uniq}b`;
    const email = `pw${uniq}@example.com`;

    // Sign up and create the first workspace.
    await page.goto("/sign-up");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.getByLabel("Your name").fill("PW Tester");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByLabel("Workspace name").fill(firstSlug);
    await page.getByRole("button", { name: /create workspace/i }).click();

    await page.waitForURL(
      new RegExp(`//${firstSlug}\\.localtest\\.me:3000/dashboard`),
      { timeout: 60_000 },
    );

    // Visit the dedicated new-workspace page while authenticated.
    await page.goto("http://localtest.me:3000/new-workspace");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    // Only the workspace fields render — no credential inputs.
    await expect(page.getByLabel("Email")).toHaveCount(0);
    await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Your name")).toHaveCount(0);
    await expect(page.getByLabel("Workspace name")).toBeVisible();

    await page.getByLabel("Workspace name").fill(secondSlug);
    await page.getByRole("button", { name: /create workspace/i }).click();

    // Redirects to the new tenant's dashboard.
    await page.waitForURL(
      new RegExp(`//${secondSlug}\\.localtest\\.me:3000/dashboard`),
      { timeout: 60_000 },
    );
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("link", { name: "Projects" })).toBeVisible();

    // Original workspace is unaffected — switching back still works.
    await page.goto(
      `http://${firstSlug}.localtest.me:3000/dashboard`,
    );
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole("link", { name: "Projects" })).toBeVisible();
  });
});
