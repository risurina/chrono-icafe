import { test, expect } from "@playwright/test";

/**
 * Browser coverage for `paymongo-billing-driver` Phase 5 — narrowed to what
 * Playwright can actually assert. Payment completion happens on PayMongo's
 * own hosted `checkout.paymongo.com` page, which this suite cannot drive or
 * complete; the payment-confirmation path is already covered server-side by
 * that plan's Phase 3 synthetic-webhook e2e case, not here.
 *
 * Same conventions as `multi-currency-plan-price.spec.ts` in this directory —
 * real dev DB, seeded tenant fixtures, manual suite (`pnpm dev` must already
 * be running, per `.ai/rules/rbac.md`).
 */
const SEEDED_PASSWORD = "Password123!";

async function signInTenant(
  page: import("@playwright/test").Page,
  host: string,
  email: string,
) {
  await page.goto(`http://${host}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

test.describe("Billing checkout — role gate", () => {
  test("a member is blocked from starting checkout (403)", async ({ page, request }) => {
    // The billing:manage role gate runs BEFORE the isBillingEnabled()/driver
    // check, so this is testable regardless of whether PayMongo (or any
    // driver) is actually configured in this dev environment.
    await signInTenant(page, "acme.localtest.me:3000", "staff@acme.test");
    const cookies = await page.context().cookies();
    const res = await request.post("http://api.localtest.me:8787/rpc/billing/checkout", {
      headers: {
        "x-tenant-slug": "acme",
        "x-tenant-host": "acme.localtest.me:3000",
        cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      },
      data: { plan: "pro" },
    });
    expect(res.status()).toBe(403);
  });

  // The PayMongo-specific assertion — that an owner/admin's checkout call
  // under a PayMongo-configured deployment returns a redirect URL pointing at
  // PayMongo's hosted checkout host — needs PAYMONGO_SECRET_KEY actually set
  // in this dev environment's apps/api/.env, which it is not by default (this
  // repo never writes real secrets into that file). Skipped rather than
  // faked; run it manually once that env var is configured locally:
  test.skip(
    "owner/admin's checkout call returns a PayMongo-hosted redirect URL (needs PAYMONGO_SECRET_KEY configured locally)",
    async () => {
      // Intentionally left as a skip placeholder — see the comment above.
    },
  );
});
