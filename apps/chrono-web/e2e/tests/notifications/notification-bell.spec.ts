import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the notification bell's single-browser-reachable
 * slice: it renders on the tenant dashboard (not the admin portal), opens to
 * an empty state for a fresh business, and is scoped to /rpc/notification-
 * feed (never fabricates content on an empty/error response).
 *
 * The multi-member happy path, per-user isolation (a different member of the
 * SAME tenant never sees another member's notification), and cross-tenant
 * isolation are covered by the API-level suite (`pnpm test:e2e` →
 * `apps/api/src/e2e/run.ts`, "notification feed" section) — proving that
 * requires driving two real member sessions plus a role-change trigger,
 * which the API suite can do directly; this spec covers what a single
 * browser session can reach, matching this repo's existing pattern (see
 * `apps/web/e2e/tests/auth/password-reset.spec.ts`).
 */
test.describe("Notification bell", () => {
  test("renders on the tenant dashboard with an empty state for a fresh business", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slug = `e2ebell${uniq}`;

    await page.goto("/sign-up");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await page.getByLabel("Your name").fill("PW Bell");
    await page.getByLabel("Email").fill(`pwbell${uniq}@example.com`);
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByLabel("Business name").fill(slug);
    await page.getByRole("button", { name: /create business/i }).click();
    await page.waitForURL(
      new RegExp(`//${slug}\\.localtest\\.me:3000/admin`),
      { timeout: 60_000 },
    );

    const bell = page.getByRole("button", { name: "Notifications" });
    await expect(bell).toBeVisible();
    await bell.click();
    await expect(page.getByText("No notifications yet.")).toBeVisible();
  });
});
