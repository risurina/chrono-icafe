import { test, expect } from "@playwright/test";

/**
 * Smoke coverage for the "By design" data-driven-partners section on the
 * apex marketing page (`.ai/plans/chrono/ready/marketing-data-driven-partners/`).
 *
 * Not a tenant-scoped-feature e2e spec in the `.ai/rules/e2e-testing.md`
 * sense (no new table/route/RLS surface, no tenant context) — static apex
 * marketing copy, mirroring the same non-tenant-chrome precedent as
 * `apps/chrono-web/e2e/tests/auth/header-footer.spec.ts`.
 *
 * Runs against the real dev server (web :3000); needs `pnpm dev` already
 * running (the config declares no `webServer`).
 */
test.describe("Apex marketing page — data-driven partners section", () => {
  test("renders the heading, category badges, and stat tiles", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", {
        name: "Built for every kind of floor — and the scale to back it up.",
      }),
    ).toBeVisible();

    for (const label of [
      "Gaming Lounges",
      "Co-working Spaces",
      "Study Cafés",
      "Franchise Groups",
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    for (const { label, value } of [
      { label: "Branches per account", value: "Unlimited" },
      { label: "Built-in modules", value: "20+" },
      { label: "Realtime sync", value: "Built-in" },
      { label: "Tenant data isolation", value: "Row-level" },
    ]) {
      const tile = page.locator("div").filter({ hasText: label }).last();
      await expect(tile.getByText(value, { exact: true })).toBeVisible();
    }
  });
});
