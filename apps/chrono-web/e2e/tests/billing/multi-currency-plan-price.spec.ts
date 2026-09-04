import { test, expect } from "@playwright/test";

/**
 * Browser coverage for unified-billing-price-source Phase 6 — the
 * `/admin/plans` multi-currency price UI (Phase 1b). This directory
 * (`apps/web/e2e/tests/billing/`) is new; `paymongo-billing-driver`'s own
 * Phase 5 was planned to use the same directory for its checkout-redirect
 * role-gate spec but has not been built yet as of this file, so there is no
 * collision in practice — if that phase lands later, keep both spec files
 * side by side rather than merging them.
 *
 * Same conventions as `platform-admin/billing.spec.ts` — real dev DB,
 * `platform@agora.test` (seeded platformRole: "admin") as the acting staff.
 * Manual suite (this Playwright config runs headed with no `webServer`;
 * `pnpm dev` must already be running, per `.ai/rules/rbac.md`).
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";

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
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
    timeout: 15_000,
  });
}

test.describe("Admin Plans — multi-currency pricing", () => {
  test("adding a second currency to a plan persists across a reload", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/plans");
    await page.waitForLoadState("networkidle");

    // Create a throwaway custom plan so this test never touches a built-in
    // row (free/pro/enterprise) or collides with other specs' fixtures.
    const key = `e2e-mc-${Date.now()}`;
    await page.getByRole("button", { name: /create plan/i }).click();
    await page.getByLabel("Key").fill(key);
    await page.getByLabel("Display name").fill("E2E Multi-Currency Plan");
    await page.getByLabel("Monthly price", { exact: true }).first().fill("10.00");
    await page.getByLabel("Annual price", { exact: true }).first().fill("100.00");
    await page.getByLabel("Currency", { exact: true }).first().fill("usd");
    await page.getByRole("button", { name: /^create$/i }).click();
    await page.waitForLoadState("networkidle");

    // Reopen the newly created plan and add a second currency row.
    await page.getByPlaceholder(/search/i).fill(key);
    await page.waitForLoadState("networkidle");
    const row = page.getByRole("row").filter({ hasText: key });
    await row.getByRole("button", { name: /edit/i }).click();

    await page.getByRole("button", { name: /add currency/i }).click();
    const priceRows = page.locator('[id^="plan-price-currency-"]');
    await expect(priceRows).toHaveCount(2);
    await priceRows.nth(1).fill("php");
    await page.locator('[id^="plan-price-monthly-"]').nth(1).fill("560.00");
    await page.locator('[id^="plan-price-annual-"]').nth(1).fill("5600.00");
    await page.getByRole("button", { name: /^save$/i }).click();
    await page.waitForLoadState("networkidle");

    // Reload the page entirely (not just re-open the dialog) to prove the
    // second currency round-tripped through the API, not just local state.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder(/search/i).fill(key);
    await page.waitForLoadState("networkidle");
    const rowAfterReload = page.getByRole("row").filter({ hasText: key });
    await rowAfterReload.getByRole("button", { name: /edit/i }).click();

    const priceRowsAfterReload = page.locator('[id^="plan-price-currency-"]');
    await expect(priceRowsAfterReload).toHaveCount(2);
    const currencies = await priceRowsAfterReload.evaluateAll((els) =>
      els.map((el) => (el as HTMLInputElement).value.toLowerCase()),
    );
    expect(currencies.sort()).toEqual(["php", "usd"]);
  });
});
