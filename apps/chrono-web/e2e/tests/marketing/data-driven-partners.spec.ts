import { test, expect } from "@playwright/test";

/**
 * Smoke coverage for the "By design" data-driven-partners section on the
 * apex marketing page (plan slug: marketing-data-driven-partners).
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

    // Every label/value pair here is unique text on the page, so a plain
    // getByText assertion is enough — no need to scope into a specific tile
    // element (which would have to guess at the DOM shape).
    for (const { label, value } of [
      { label: "Branches per account", value: "Unlimited" },
      { label: "Built-in workflows", value: "20+" },
      { label: "Realtime sync", value: "Built-in" },
      { label: "Tenant data isolation", value: "Row-level" },
    ]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
      await expect(page.getByText(value, { exact: true })).toBeVisible();
    }
  });

  test("stat grid has no horizontal overflow in the 640-768px risk band", async ({ page }) => {
    // This band is exactly what CONDITION 5 (plan audit) fixed: Grid's
    // cols={4} maps to sm:grid-cols-4 (a 640px jump straight to 4 columns),
    // which would overflow StatTile's min-w-[160px] cards at this width —
    // fixed with cols={2} + an explicit lg:grid-cols-4 override.
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto("/");
    await expect(page.getByText("Built-in workflows", { exact: true })).toBeVisible();

    const hasOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(hasOverflow).toBe(false);
  });
});
