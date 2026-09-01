import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the manual subscription override feature on the
 * platform admin org detail page (`/admin/organizations/:id`): the happy
 * path (set → banner renders → GET reflects it → remove), the role gate (a
 * staff account with no platform role sees no override button and a direct
 * API call 403s — there is no seeded platform "viewer" holder, see
 * `apps/api/src/seed.ts`; the existing `organizations.spec.ts` role-gate test
 * uses the same no-platform-role substitution), and missing-reason
 * validation (dialog confirm stays disabled, and a direct API call 400s).
 *
 * A throwaway `test-<timestamp>` org is used, never a shared seeded org —
 * this suite runs `fullyParallel: false, workers: 1` against the real dev DB.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

async function signUpWorkspace(
  page: import("@playwright/test").Page,
  opts: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Workspace name").fill(opts.slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${opts.slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

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
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

test.describe("Platform Admin: manual subscription override", () => {
  test("platform admin sets and removes an override; banner and GET reflect it", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-override${uniq}`;
    const ownerEmail = `test-override-owner${uniq}@example.com`;

    await signUpWorkspace(page, { name: "Override Owner", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await adminPage.goto("http://localtest.me:3000/admin");
    await adminPage.waitForLoadState("networkidle");
    await adminPage.getByPlaceholder("Search organizations…").fill(slug);
    const row = adminPage.getByRole("row").filter({ hasText: slug });
    await row.getByRole("button", { name: "View" }).click();
    await adminPage.waitForURL(/\/admin\/organizations\/.+/);

    await adminPage.getByRole("button", { name: "Override plan" }).click();
    await adminPage.getByLabel("Reason (required)").fill("e2e: comped enterprise pilot");
    await adminPage.getByRole("button", { name: "Confirm override" }).click();

    await expect(adminPage.getByText("Manual override active")).toBeVisible();
    await expect(adminPage.getByText("e2e: comped enterprise pilot")).toBeVisible();
    await expect(adminPage.getByText(PLATFORM_ADMIN_EMAIL)).toBeVisible();

    // Remove the override.
    await adminPage.getByRole("button", { name: "Remove override" }).click();
    await adminPage.getByRole("button", { name: "Remove override" }).last().click();
    await expect(adminPage.getByText("Manual override active")).toHaveCount(0);

    await adminContext.close();
  });

  test("a staff account with no platform role sees no override button and is blocked from the API", async ({
    page,
  }) => {
    // acme's seeded owner has platformRole: null by the column default — the
    // same substitution the existing organizations.spec.ts role-gate test
    // uses, since no platform "viewer" account is seeded.
    await signInStaff(page, "acme.localtest.me:3000", "owner@acme.test");
    await page.waitForURL(/\/dashboard/, { timeout: 30_000 });

    await page.goto("http://localtest.me:3000/admin");
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });

    const res = await page.request.patch(
      `${API_URL}/rpc-admin/organizations/nonexistent/subscription/override`,
      {
        headers: { "x-platform-admin": "1" },
        data: { plan: "pro", seats: 20, status: "active", reason: "test" },
      },
    );
    expect(res.status()).toBe(403);
  });

  test("an empty reason is rejected: dialog confirm stays disabled and the API 400s", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-override-reason${uniq}`;
    const ownerEmail = `test-override-reason-owner${uniq}@example.com`;

    await signUpWorkspace(page, { name: "Reason Owner", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await adminPage.goto("http://localtest.me:3000/admin");
    await adminPage.waitForLoadState("networkidle");
    await adminPage.getByPlaceholder("Search organizations…").fill(slug);
    const row = adminPage.getByRole("row").filter({ hasText: slug });
    await row.getByRole("button", { name: "View" }).click();
    await adminPage.waitForURL(/\/admin\/organizations\/.+/);

    await adminPage.getByRole("button", { name: "Override plan" }).click();
    // Reason left empty — confirm must stay disabled.
    await expect(adminPage.getByRole("button", { name: "Confirm override" })).toBeDisabled();

    const orgId = adminPage.url().split("/organizations/")[1];
    const res = await adminPage.request.patch(
      `${API_URL}/rpc-admin/organizations/${orgId}/subscription/override`,
      {
        headers: { "x-platform-admin": "1" },
        data: { plan: "pro", seats: 20, status: "active", reason: "" },
      },
    );
    expect(res.status()).toBe(400);

    await adminContext.close();
  });
});
