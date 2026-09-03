import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the expanded platform admin dashboard (`/admin`,
 * `GET /rpc-admin/metrics/overview` extended fields). Read-only — no
 * mutating action lives on this page, so the platform-admin-appropriate
 * triad is: happy path + role gate + cross-tenant aggregate (not scoped to
 * one tenant) + independent per-section failure handling. See
 * `.ai/plans/agora/active/admin-dashboard-expansion/README.md`.
 *
 * Relies on `apps/api/src/seed.ts` seeding three tenants with distinct
 * `tenantSubscription` statuses (acme: active, contoso: past_due, globex:
 * trialing) and a `platform-viewer@agora.test` viewer-role user — without
 * that, the trial/past-due assertions and the role-gate case have nothing
 * to run against.
 *
 * Counts are asserted as DELTAS, not absolute numbers — this suite runs
 * against the real dev DB, which already carries prior seed/test-run
 * organizations (same convention as `organizations.spec.ts`).
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const PLATFORM_VIEWER_EMAIL = "platform-viewer@agora.test";
const SEEDED_PASSWORD = "Password123!";

async function signInStaff(page: import("@playwright/test").Page, email: string) {
  await page.goto("http://localtest.me:3000/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

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
  await page.getByLabel("Business name").fill(opts.slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${opts.slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

/**
 * Reads a KPI tile's numeric value from the rendered page — `page.request`
 * does not carry whatever cross-origin auth mechanism the in-page client
 * uses to reach the API (confirmed by the same failure mode in the
 * unmodified `metrics.spec.ts`), so this suite asserts against the UI the
 * admin actually sees rather than raw API responses.
 */
async function statValue(
  page: import("@playwright/test").Page,
  label: string,
): Promise<number> {
  const container = page.getByText(label, { exact: true }).locator("..");
  const text = (await container.locator("p.tabular-nums").innerText()).trim();
  return Number(text);
}

test.describe("Platform Admin Dashboard", () => {
  test("a platform admin sees KPI tiles, stub tiles, and list sections reflecting the seeded tenants", async ({
    page,
  }) => {
    await signInStaff(page, PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin");
    await page.waitForLoadState("networkidle");

    const totalBefore = await statValue(page, "Total tenants");

    const uniq = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const slug = `test-padmin-dash${uniq}`;
    await signUpWorkspace(page, {
      name: "Dash Owner",
      email: `test-padmin-dash-owner${uniq}@example.com`,
      slug,
    });

    await signInStaff(page, PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin");
    await page.waitForLoadState("networkidle");

    const totalAfter = await statValue(page, "Total tenants");
    expect(totalAfter).toBe(totalBefore + 1);

    // Seeded fixtures (apps/api/src/seed.ts): globex is trialing, contoso is
    // past_due — real, non-zero signals this dashboard's KPIs depend on.
    expect(await statValue(page, "Trial tenants")).toBeGreaterThanOrEqual(1);
    expect(await statValue(page, "Tenants past due")).toBeGreaterThanOrEqual(1);

    // No fabricated data — these render as explicit "not available" notes,
    // never a number, for the three metrics with no backing data source.
    await expect(page.getByText(/storage usage/i)).toBeVisible();
    await expect(page.getByText(/pending usage metering/i).first()).toBeVisible();
    await expect(page.getByText(/Est\. MRR/i)).toBeVisible();

    // The just-created org appears in "Recent tenant registrations".
    await expect(page.getByRole("link", { name: slug })).toBeVisible();

    // The seeded past-due tenant appears in "Tenants past due".
    await expect(page.getByRole("heading", { name: "Tenants past due" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Contoso Ltd" })).toBeVisible();

    await expect(page.getByRole("heading", { name: "System alerts" })).toBeVisible();
    await expect(page.getByText(/Pending — arrives with plan #17/i)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Support tickets" })).toBeVisible();
    await expect(page.getByText(/Pending — arrives with plan #10/i)).toBeVisible();

    // Check newly added charts
    await expect(page.getByRole("heading", { name: "User growth" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tenant activity" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Est. revenue growth" }),
    ).toBeVisible();

    // Check dependency legend
    await expect(page.getByText(/Pending dashboard features/i)).toBeVisible();
    await expect(page.getByText(/Blocked on #7 Payments\/dunning/i)).toBeVisible();
  });

  test("a platform viewer sees the same read-only dashboard with no mutating control", async ({
    page,
  }) => {
    await signInStaff(page, PLATFORM_VIEWER_EMAIL);
    await page.goto("http://localtest.me:3000/admin");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Total tenants")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Quick actions" })).toBeVisible();

    // Exactly the four navigation quick actions — no mutating control such
    // as a "Create" or "Delete" button anywhere on the page.
    await expect(page.getByRole("link", { name: "Send announcement" })).toBeVisible();
    await expect(page.getByRole("link", { name: "View organizations" })).toBeVisible();
    await expect(page.getByRole("link", { name: "View audit log" })).toBeVisible();
    await expect(page.getByRole("link", { name: "View billing" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Create Tenant/i })).toBeDisabled();
    await expect(page.getByRole("button", { name: /Create User/i })).toBeDisabled();
    await expect(page.getByRole("button", { name: /delete/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /suspend/i })).toHaveCount(0);
  });

  test("the dashboard aggregates across tenants, not just the acting admin's own membership", async ({
    page,
  }) => {
    await signInStaff(page, PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin");
    await page.waitForLoadState("networkidle");

    // Platform admins hold no tenant membership at all (see .ai/rules/auth.md)
    // — a non-zero, multi-tenant aggregate proves this reads across every
    // tenant rather than being accidentally scoped to one.
    expect(await statValue(page, "Total tenants")).toBeGreaterThanOrEqual(3);
    expect(await statValue(page, "Trial tenants")).toBeGreaterThanOrEqual(1);
    expect(await statValue(page, "Tenants past due")).toBeGreaterThanOrEqual(1);
  });

  test("a failed section degrades independently without blanking the rest of the dashboard", async ({
    page,
  }) => {
    await signInStaff(page, PLATFORM_ADMIN_EMAIL);

    // `?` is a single-character glob wildcard in Playwright route patterns,
    // not a query-string marker — use a RegExp so it matches the literal `?`.
    await page.route(/\/rpc-admin\/audit\?/, (route) =>
      route.fulfill({ status: 500, body: "{}" }),
    );

    await page.goto("http://localtest.me:3000/admin");
    await page.waitForLoadState("networkidle");

    // The failed section shows its own error note...
    const activityCard = page
      .getByRole("heading", { name: "Recent activity" })
      .locator("..")
      .locator("..");
    await expect(activityCard.getByText(/couldn.t load this/i)).toBeVisible();

    // ...while the rest of the page still renders normally.
    await expect(page.getByText("Total tenants")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Recent tenant registrations" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Tenants past due" })).toBeVisible();
  });
});
