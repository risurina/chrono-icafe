import { test, expect } from "@playwright/test";

test("roles UI: create, list, edit, delete a custom role", async ({ page }) => {
  const uniq = Date.now();
  const slug = `testroles${uniq}`;
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill("PW Roles");
  await page.getByLabel("Email").fill(`test-roles${uniq}@example.com`);
  await page.getByLabel("Password", { exact: true }).fill("Password123!");
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), { timeout: 60_000 });

  const base = `http://${slug}.localtest.me:3000`;
  await page.goto(`${base}/dashboard/settings/roles`);
  await page.waitForLoadState("networkidle");

  // Built-ins listed and marked immutable
  await expect(page.getByText("Built-in").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "New role" })).toBeVisible();

  // Create
  await page.getByLabel("Key").fill("billing-manager");
  await page.getByLabel("Name").fill("Billing Manager");
  await page.locator("#billing-read").click();
  await page.locator("#billing-manage").click();
  await page.getByRole("button", { name: "Create role" }).click();
  await expect(page.getByText("Role created.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Billing Manager")).toBeVisible();

  // Edit
  await page.getByRole("button", { name: "Edit" }).first().click();
  await expect(page.locator("#billing-manage")).toHaveAttribute("aria-checked", "true");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Role updated.")).toBeVisible({ timeout: 15_000 });

  // Delete
  await page.getByRole("button", { name: "Delete" }).first().click();
  await expect(page.getByText("Role deleted.")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Billing Manager")).toHaveCount(0);
});
