import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the platform payments/transactions surface
 * (`/admin/transactions`, `/rpc-admin/transactions/*`). `STRIPE_SECRET_KEY` is
 * unset in this dev env, so `isBillingEnabled()` is false and the read routes
 * short-circuit with `{ enabled: false }` — this spec covers that state and the
 * API permission gate. The full happy-path / refund / idempotency /
 * double-refund / cross-tenant-isolation matrix (which needs billing actually
 * enabled + a signed synthetic webhook) is exercised end-to-end in the enforced
 * offline suite `apps/api/src/e2e/run.ts` (block "W0d"), per the plan's Phase 5
 * — that suite can toggle billing on and drive the centralized webhook
 * ingress (`/api/v1/webhooks/stripe`, since the legacy `/billing/webhook`
 * route was deleted in Phase 6), which a headed browser against a fixed dev
 * env cannot.
 *
 * Same conventions as `billing.spec.ts` — real dev DB,
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

test.describe("Platform Transactions", () => {
  test("a platform admin sees the not-configured state when billing is disabled", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/transactions");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByText(/billing is not configured for this environment/i),
    ).toBeVisible();
    // No transactions table renders while billing is disabled.
    await expect(page.getByPlaceholder(/search tenant or transaction id/i)).toHaveCount(
      0,
    );
  });

  test("Transactions is reachable from the Billing page cross-link", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/billing");
    await page.waitForLoadState("networkidle");
    await page.getByRole("link", { name: /^transactions$/i }).first().click();
    await page.waitForURL(/\/admin\/transactions/);
    await expect(
      page.getByRole("heading", { name: /transactions/i }),
    ).toBeVisible();
  });

  test("a tenant owner with no platform role cannot read the transactions list", async ({
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

    const apiRes = await page.request.get(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}/rpc-admin/transactions`,
    );
    expect(apiRes.status()).toBe(403);
  });

  test("a tenant owner cannot issue a refund (permission gate)", async ({ page }) => {
    await page.goto("http://localtest.me:3000/login");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill("owner@acme.test");
    await page.getByLabel("Password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
      timeout: 15_000,
    });

    const apiRes = await page.request.post(
      `${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787"}/rpc-admin/transactions/does-not-exist/refund`,
      {
        headers: { "x-platform-admin": "1", "content-type": "application/json" },
        data: { reason: "should be blocked" },
      },
    );
    expect(apiRes.status()).toBe(403);
  });
});
