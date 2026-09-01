import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the cross-tenant usage/growth metrics page
 * (`/admin/metrics`, `GET /rpc-admin/metrics/overview`,
 * `GET /rpc-admin/metrics/tenants`). Read-only — no mutating action, so this
 * is the platform-admin-appropriate equivalent of the tenant happy/role/
 * isolation triad: happy path + role gate + no cross-tenant leak (see
 * `.ai/plans/agora/active/usage-growth-metrics/README.md`, E2E section).
 *
 * The no-leak assertion depends on `apps/api/src/seed.ts` seeding `acme` with
 * 3 projects and `contoso` with 2 (a deliberate Phase 2 edit) — without that
 * distinction, a naive "counts never swap" assertion would pass whether the
 * per-tenant `project` count query is correct or not.
 *
 * Same conventions as `organizations.spec.ts` / `staff.spec.ts` — real dev DB,
 * `platform@agora.test` (seeded platformRole: "admin") as the acting staff.
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

test.describe("Platform Metrics", () => {
  test("a platform admin sees stat cards and a populated per-tenant table", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/metrics");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Total tenants")).toBeVisible();
    await expect(page.getByText("Active")).toBeVisible();
    await expect(page.getByText("Suspended")).toBeVisible();
    await expect(page.getByText("Deleting")).toBeVisible();

    await expect(page.getByText(/signups \(last 90 days\)/i)).toBeVisible();

    const acmeRow = page.getByRole("row").filter({ hasText: "acme" });
    await expect(acmeRow).toBeVisible();
    const contosoRow = page.getByRole("row").filter({ hasText: "contoso" });
    await expect(contosoRow).toBeVisible();
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

    const overviewRes = await page.request.get(
      `${API_URL}/rpc-admin/metrics/overview`,
    );
    expect(overviewRes.status()).toBe(403);
    const tenantsRes = await page.request.get(
      `${API_URL}/rpc-admin/metrics/tenants`,
    );
    expect(tenantsRes.status()).toBe(403);
  });

  test("the per-tenant table shows each tenant's own distinct project count, never the other's", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const res = await page.request.get(
      `${API_URL}/rpc-admin/metrics/tenants?pageSize=100`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      items: { tenantSlug: string; projectCount: number }[];
    };
    const acme = body.items.find((i) => i.tenantSlug === "acme");
    const contoso = body.items.find((i) => i.tenantSlug === "contoso");
    expect(acme).toBeTruthy();
    expect(contoso).toBeTruthy();

    // Seeded distinctly in apps/api/src/seed.ts: acme has a third project.
    expect(acme!.projectCount).toBe(3);
    expect(contoso!.projectCount).toBe(2);
    expect(acme!.projectCount).not.toBe(contoso!.projectCount);

    // Same assertion through the rendered page, so a UI-layer mixup (e.g. the
    // wrong row rendering the wrong tenant's count) would also be caught.
    await page.goto("http://localtest.me:3000/admin/metrics");
    await page.waitForLoadState("networkidle");
    const acmeRow = page.getByRole("row").filter({ hasText: "acme" });
    const contosoRow = page.getByRole("row").filter({ hasText: "contoso" });
    await expect(acmeRow.getByRole("cell", { name: "3", exact: true })).toBeVisible();
    await expect(contosoRow.getByRole("cell", { name: "2", exact: true })).toBeVisible();
  });
});
