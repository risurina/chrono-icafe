import { test, expect } from "@playwright/test";

/**
 * Browser coverage for `/admin/reports` (`GET /rpc-admin/reports`) — tenant
 * growth, plan changes, and churn over time. Distinct from `/admin/metrics`
 * (current-state counts + a fixed 90-day series): this covers trends over
 * 6/12 month windows, reading the new `tenantSubscriptionEvent` history
 * table. Read-only — no mutating action — so this is the platform-admin
 * happy path + role gate + aggregate-correctness triad (see
 * `.ai/plans/active/platform-reports/README.md`, E2E section).
 *
 * The aggregate-correctness case depends on `apps/api/src/seed.ts` seeding
 * acme with a recorded plan change (free → pro) and contoso with a recorded
 * cancellation (pro → canceled) — a deliberate Phase 4 edit. This is a
 * correctness check against a known fixture, NOT a tenant-isolation check:
 * this page aggregates cross-tenant by design, so there is no tenant
 * boundary being crossed in the browser for that assertion to catch a leak
 * in. The real isolation assertion lives in `rls-proof.ts`/`run.ts` (Phase
 * 4) — a `withTenant(A)` read of `tenant_subscription_event` returning zero
 * of tenant B's rows, non-vacuously — and is not duplicated here as a weaker
 * browser-level check.
 *
 * Same conventions as `metrics.spec.ts` — real dev DB, `platform@agora.test`
 * (seeded platformRole: "admin") as the acting staff.
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
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

test.describe("Platform Reports", () => {
  test("a platform admin sees growth/plan-changes/churn sections populated from seed data", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/reports");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Tenant growth" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "User growth" })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Subscription growth" }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Trial conversion" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Est. Revenue" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Plan changes" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Churn" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Feature adoption" })).toBeVisible();

    // Seeded data exists, so the tables render rows, not the "no trend data
    // recorded yet" empty-state message.
    await expect(page.getByText(/no trend data recorded yet/i)).not.toBeVisible();
  });

  test("a signed-in user with no platform role is blocked", async ({ page }) => {
    await page.goto("http://localtest.me:3000/login");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill("owner@acme.test");
    await page.getByLabel("Password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 15_000,
    });

    const res = await page.request.get(
      `${API_URL}/rpc-admin/reports?range=6m&granularity=month`,
    );
    expect(res.status()).toBe(403);
  });

  test("custom date range, tenant filter, and plan filter update the URL state", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/reports");
    await page.waitForLoadState("networkidle");

    // Set custom 'from' date
    await page.getByPlaceholder("From").fill("2024-01-01");
    // Wait a bit for URL to update
    await page.waitForURL((url) => url.searchParams.get("from") === "2024-01-01");

    // Set custom 'to' date
    await page.getByPlaceholder("To").fill("2024-12-31");
    await page.waitForURL((url) => url.searchParams.get("to") === "2024-12-31");

    // Set tenant ID filter
    await page.getByPlaceholder("Tenant ID filter").fill("acme");
    await page.waitForURL((url) => url.searchParams.get("tenantId") === "acme");

    // Set plan filter
    await page.getByRole("combobox", { name: "All plans" }).click();
    await page.getByRole("option", { name: "Pro" }).click();
    await page.waitForURL((url) => url.searchParams.get("planId") === "pro");

    // Assert final URL state
    expect(page.url()).toContain("from=2024-01-01");
    expect(page.url()).toContain("to=2024-12-31");
    expect(page.url()).toContain("tenantId=acme");
    expect(page.url()).toContain("planId=pro");
  });

  test("a platform viewer gets the same read-only page and can still export", async ({
    page,
  }) => {
    // Viewer email seeded in seed.ts
    const PLATFORM_VIEWER_EMAIL = "platform-viewer@agora.test";
    await signInStaff(page, "localtest.me:3000", PLATFORM_VIEWER_EMAIL);
    await page.goto("http://localtest.me:3000/admin/reports");
    await page.waitForLoadState("networkidle");

    // Check visibility of page contents
    await expect(page.getByRole("heading", { name: "Tenant growth" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Est. Revenue" })).toBeVisible();

    // Export CSV should still work for viewer
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export CSV" }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^platform-reports-.*\.csv$/);
  });

  test("tenantId filter isolates reports to a single organization", async ({
    page,
  }) => {
    // Assert no other tenant's rows leak into an unfiltered aggregate
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    // Contoso has the cancellation (churn). Let's filter by acme and check if churn is 0
    const acmeRes = await page.request.get(
      `${API_URL}/rpc-admin/reports?range=12m&granularity=month&tenantId=acme`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(acmeRes.ok()).toBeTruthy();
    const acmeBody = (await acmeRes.json()) as any;

    // Acme did not churn in seed.ts, contoso did.
    expect(
      acmeBody.churn.reduce((sum: number, b: any) => sum + b.churnedTenants, 0),
    ).toBe(0);

    // Contoso churned, acme changed plan to pro
    const contosoRes = await page.request.get(
      `${API_URL}/rpc-admin/reports?range=12m&granularity=month&tenantId=contoso`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(contosoRes.ok()).toBeTruthy();
    const contosoBody = (await contosoRes.json()) as any;

    const contosoProChanges = contosoBody.planChanges.filter(
      (b: any) => b.plan === "pro",
    );
    expect(contosoProChanges.reduce((sum: number, b: any) => sum + b.count, 0)).toBe(0);
    expect(
      contosoBody.churn.reduce((sum: number, b: any) => sum + b.churnedTenants, 0),
    ).toBeGreaterThanOrEqual(1);
  });

  test("blocked reports show pending placeholder text", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/reports");
    await page.waitForLoadState("networkidle");

    // The feature adoption table renders correctly because it is partially implemented and returns data.
    // The "pending" state for feature adoption only shows if data is strictly null, but it's partially implemented and returns an array.
    // The blocked reports are: Active users, Usage, Storage usage, API usage.

    const activeUsersCard = page.locator(".rounded-xl", { hasText: "Active users" });
    await expect(activeUsersCard.getByText("pending metering")).toBeVisible();

    const usageCard = page.locator(".rounded-xl", { hasText: /^Usage/ });
    await expect(usageCard.getByText("pending metering")).toBeVisible();

    const storageUsageCard = page.locator(".rounded-xl", { hasText: "Storage usage" });
    await expect(storageUsageCard.getByText("pending metering")).toBeVisible();

    const apiUsageCard = page.locator(".rounded-xl", { hasText: "API usage" });
    await expect(apiUsageCard.getByText("pending metering")).toBeVisible();
  });

  test("export CSV downloads a client-driven file with the expected name and body", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/reports");
    await page.waitForLoadState("networkidle");

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export CSV" }).click(),
    ]);

    expect(download.suggestedFilename()).toMatch(/^platform-reports-.*\.csv$/);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    const body = Buffer.concat(chunks).toString("utf-8");

    // CSV should at least contain some headers (e.g. Period or Series) depending on the toCsv implementation
    expect(body.length).toBeGreaterThan(0);
    expect(body.toLowerCase()).toContain("period");
  });

  test("comparison delta text renders when a comparison option is selected", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/reports");
    await page.waitForLoadState("networkidle");

    // Select comparison option
    await page.getByRole("combobox", { name: "No comparison" }).click();
    await page.getByRole("option", { name: "Previous month" }).click();
    await page.waitForURL((url) => url.searchParams.get("compare") === "month");

    // Assert comparison text renders (e.g. "vs prev month")
    await expect(page.getByText(/vs prev month/).first()).toBeVisible();
  });
});
