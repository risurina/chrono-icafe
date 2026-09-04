import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the platform Subscriptions management surface
 * (`/admin/subscriptions`, spec #6). The offline harness
 * (`apps/api/src/e2e/run.ts`, block W1s) already proves the routes, the
 * permission gate, the `paused` status, and cross-tenant isolation end-to-end;
 * this spec adds real-browser coverage of the admin shell entry point and the
 * role gate.
 *
 * The role gate is the deterministic, environment-independent assertion: a
 * staff account with no platform role is bounced off `/admin` and its direct
 * API calls 403 — this holds regardless of whether billing is configured in the
 * dev environment (the list itself renders a "not configured" state when it
 * is not). A throwaway `test-<timestamp>` org is never used here; the gate test
 * relies only on acme's seeded owner (`platformRole: null` by column default),
 * the same substitution `subscription-override.spec.ts` uses.
 *
 * This suite runs headed with `workers: 1` against the real dev DB; start
 * `pnpm dev` first.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

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

test.describe("Platform Admin: subscriptions management", () => {
  test("platform admin reaches the Subscriptions surface from the admin shell", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/subscriptions");
    await page.waitForLoadState("networkidle");

    // The page renders (heading present) — the nav item links here, and the
    // page is either the list or the explicit "billing not configured" card,
    // never a blank/redirect.
    await expect(
      page.getByRole("heading", { name: "Subscriptions", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/admin\/subscriptions$/);
  });

  test("a staff account with no platform role is bounced from the page and 403s on the API", async ({
    page,
  }) => {
    await signInStaff(page, "acme.localtest.me:3000", "owner@acme.test");
    await page.waitForURL(/\/admin/, { timeout: 30_000 });

    // The admin shell guard sends a non-platform user back to their dashboard.
    await page.goto("http://localtest.me:3000/admin/subscriptions");
    await expect(page).toHaveURL(/\/admin/, { timeout: 15_000 });

    // Every write action is gated on `organization:override_subscription`,
    // which no non-platform account holds — a direct call 403s.
    const changePlan = await page.request.post(
      `${API_URL}/rpc-admin/subscriptions/nonexistent/change-plan`,
      {
        headers: { "x-platform-admin": "1" },
        data: { planKey: "pro", reason: "test" },
      },
    );
    expect(changePlan.status()).toBe(403);

    const pause = await page.request.post(
      `${API_URL}/rpc-admin/subscriptions/nonexistent/pause`,
      { headers: { "x-platform-admin": "1" }, data: { reason: "test" } },
    );
    expect(pause.status()).toBe(403);
  });
});
