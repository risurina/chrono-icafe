import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the platform billing/revenue rollup (`/admin/billing`,
 * `/rpc-admin/billing/*`). `STRIPE_SECRET_KEY` is unset in this dev env, so
 * `isBillingEnabled()` is false and both routes short-circuit with
 * `{ enabled: false }` — this spec covers that state, per the plan's Phase 4
 * E2E Testing Note. A cross-tenant-leak test needs billing actually enabled
 * (a configured Stripe key), which this env does not have, so it is not
 * exercised here.
 *
 * Same conventions as `staff.spec.ts` / `organizations.spec.ts` — real dev DB,
 * `platform@agora.test` (seeded platformRole: "admin") as the acting staff.
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

test.describe("Platform Billing", () => {
  test("a platform admin sees the not-configured state when billing is disabled", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/billing");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByText(/billing is not configured for this environment/i),
    ).toBeVisible();
    // No per-plan or per-tenant rollup renders while disabled.
    await expect(page.getByText(/by plan & status/i)).toHaveCount(0);
  });

  test("the org detail page shows no Stripe link/badge when billing is disabled", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin");
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("Search organizations…").fill("acme");
    const row = page.getByRole("row").filter({ hasText: "acme" });
    await row.getByRole("button", { name: "View" }).click();
    await page.waitForURL(/\/admin\/organizations\/.+/);

    // Anchor on the "Plan & subscription" card actually rendering (not just
    // the page loading generally) — otherwise this assertion would pass
    // vacuously if the card failed to render at all.
    await expect(page.getByText("Plan & subscription")).toBeVisible();
    await expect(page.getByRole("link", { name: /open in stripe/i })).toHaveCount(0);
    await expect(page.getByText(/invoice status unavailable/i)).toHaveCount(0);
  });

  test("a tenant owner with no platform role cannot read the billing rollup", async ({
    page,
  }) => {
    await page.goto("http://localtest.me:3000/login");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill("owner@acme.test");
    await page.getByLabel("Password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
      timeout: 15_000,
    });

    const res = await page.request.get(
      "http://localtest.me:3000/admin/billing",
    );
    // The page itself renders client-side; assert the underlying API gate.
    const apiRes = await page.request.get(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}/rpc-admin/billing/summary`,
    );
    expect(apiRes.status()).toBe(403);
    expect(res.status()).toBeLessThan(500);
  });
});
