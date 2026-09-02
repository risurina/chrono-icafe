import { test, expect } from "@playwright/test";

// Smoke test for the settings submodules: a fresh tenant owner opens Settings,
// sees the section overview + sub-nav, navigates into a couple of sections, and
// confirms an old top-level path still resolves via redirect.
test.describe("Settings submodules navigation", () => {
  test("owner navigates the settings sub-nav and old paths redirect", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slug = `e2eset${uniq}`;
    const email = `pwset${uniq}@example.com`;
    const base = `http://${slug}.localtest.me:3000`;

    // Create a fresh workspace (owner) — reuses the sign-up onboarding flow.
    await page.goto("/sign-up");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);

    await page.getByLabel("Your name").fill("PW Settings");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByLabel("Workspace name").fill(slug);
    await page.getByRole("button", { name: /create workspace/i }).click();

    await page.waitForURL(
      new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`),
      { timeout: 60_000 },
    );

    // Sidebar → Settings lands on the settings overview.
    await page.getByRole("link", { name: "Settings" }).click();
    await page.waitForURL(`${base}/dashboard/settings`);
    await expect(
      page.getByRole("heading", { name: "Settings" }),
    ).toBeVisible();

    // Settings sub-nav is present and drives navigation between submodules.
    await page.getByRole("link", { name: "Branding" }).first().click();
    await page.waitForURL(`${base}/dashboard/settings/branding`);

    await page.getByRole("link", { name: "Members" }).first().click();
    await page.waitForURL(`${base}/dashboard/settings/crew`);
    await expect(
      page.getByRole("heading", { name: "Members" }),
    ).toBeVisible();

    // An old top-level path redirects to its new nested location.
    await page.goto(`${base}/dashboard/security`);
    await page.waitForURL(`${base}/dashboard/settings/security`);
  });
});
