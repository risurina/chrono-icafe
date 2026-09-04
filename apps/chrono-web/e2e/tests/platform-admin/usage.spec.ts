import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the cross-tenant usage & limits page (`/admin/usage`,
 * `GET /rpc-admin/usage/overview`, `/rpc-admin/usage/tenants`,
 * `/rpc-admin/usage/organizations/:id`). Read-only in this phase (the quota
 * mutation gate is added by Phase 5), so this is the platform-admin equivalent
 * of the happy/role/isolation triad: happy path + role gate + no cross-tenant
 * leak.
 *
 * The no-leak assertion depends on `apps/api/src/seed.ts` seeding `acme` with 3
 * projects and `contoso` with 2 — without that distinction a naive "counts
 * never swap" assertion would pass whether the per-tenant `project` count is
 * correct or not.
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
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
    timeout: 15_000,
  });
}

test.describe("Platform Usage & Limits", () => {
  test("a platform admin sees stat cards and a populated per-tenant usage table", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/usage");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Total tenants")).toBeVisible();
    await expect(page.getByText("Approaching limit")).toBeVisible();
    await expect(page.getByText("Over limit")).toBeVisible();
    await expect(page.getByText("Per-tenant usage")).toBeVisible();

    const acmeRow = page.getByRole("row").filter({ hasText: "acme" });
    await expect(acmeRow).toBeVisible();
    const contosoRow = page.getByRole("row").filter({ hasText: "contoso" });
    await expect(contosoRow).toBeVisible();
  });

  test("a signed-in user with no platform role is blocked from the usage routes", async ({
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

    const overviewRes = await page.request.get(`${API_URL}/rpc-admin/usage/overview`);
    expect(overviewRes.status()).toBe(403);
    const tenantsRes = await page.request.get(`${API_URL}/rpc-admin/usage/tenants`);
    expect(tenantsRes.status()).toBe(403);
  });

  test("the per-tenant table shows each tenant's own distinct project count, never the other's", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const res = await page.request.get(
      `${API_URL}/rpc-admin/usage/tenants?pageSize=100`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      items: {
        tenantSlug: string;
        resources: { resource: string; used: number | null }[];
      }[];
    };
    const acme = body.items.find((i) => i.tenantSlug === "acme");
    const contoso = body.items.find((i) => i.tenantSlug === "contoso");
    expect(acme).toBeTruthy();
    expect(contoso).toBeTruthy();

    const acmeProjects = acme!.resources.find((r) => r.resource === "projects");
    const contosoProjects = contoso!.resources.find((r) => r.resource === "projects");
    // Seeded distinctly in apps/api/src/seed.ts: acme 3 projects, contoso 2.
    expect(acmeProjects!.used).toBe(3);
    expect(contosoProjects!.used).toBe(2);
    expect(acmeProjects!.used).not.toBe(contosoProjects!.used);
  });
});
