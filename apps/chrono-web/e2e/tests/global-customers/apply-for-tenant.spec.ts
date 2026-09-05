import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Global customer identity (agora/customer-auth) — a platform-wide account
 * that self-service "applies" to become a tenant-scoped customer
 * (tenantMember, linked via customerId). See
 * .ai/plans/agora/active/global-customers/README.md.
 */

async function signUpNewWorkspace(page: Page): Promise<{ slug: string }> {
  const uniq = faker.string.alphanumeric({ length: 8, casing: "lower" });
  const slug = `test-${uniq}`;
  const email = faker.internet.email({ provider: "example.com" });

  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);

  await page.getByLabel("Your name").fill(faker.person.fullName());
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Password123!");
  await page.getByLabel("Business name").fill(slug);

  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });

  return { slug };
}

test.describe("Global customer — apply to a tenant", () => {
  test("signs up once, applies to two tenants independently, isolated per tenant", async ({
    page,
  }) => {
    // ── Tenant A: create business (owner session A is now active) ──
    const { slug: slugA } = await signUpNewWorkspace(page);

    // ── Global customer sign-up (separate identity/cookie, unaffected by
    // the staff session above) ──
    const customerEmail = faker.internet.email({ provider: "example.com" });
    await page.goto("/portal/sign-up");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await page.getByLabel("Your name").fill("Global Test Customer");
    await page.getByLabel("Email").fill(customerEmail);
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByRole("button", { name: /create account/i }).click();
    await page.waitForURL(/\/portal$/, { timeout: 30_000 });
    await expect(page.getByText("Welcome, Global Test Customer")).toBeVisible();

    // ── Apply to tenant A's portal (happy path) ──
    await page.goto(`http://${slugA}.localtest.me:3000/member`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Join this business" })).toBeVisible();
    await page.getByRole("button", { name: "Apply" }).click();
    // Reloads into the member area once the linked tenantMember exists.
    await expect(
      page.getByRole("heading", { name: /^Welcome/ }),
    ).toBeVisible({ timeout: 15_000 });

    // ── Cross-tenant isolation: tenant A's owner session is still live —
    // the applied customer shows up in tenant A's Members list (the applied
    // customer has no chronoMemberProfile row, so this is the real proof the
    // Members list's LEFT JOIN surfaces every tenantMember, not just
    // profiled ones — see .ai/plans/chrono/active/customers-members-merge/README.md). ──
    await page.goto(`http://${slugA}.localtest.me:3000/admin/members`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(customerEmail)).toBeVisible({ timeout: 15_000 });

    // ── Tenant B: create a second, independent business. ──
    const { slug: slugB } = await signUpNewWorkspace(page);

    // Before applying to B, tenant B's own Members list must NOT show this
    // global customer — the two tenant memberships are fully independent.
    await page.goto(`http://${slugB}.localtest.me:3000/admin/members`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(customerEmail)).not.toBeVisible();

    // ── Apply to tenant B independently (same global identity, no
    // second global sign-up) ──
    await page.goto(`http://${slugB}.localtest.me:3000/member`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Join this business" })).toBeVisible();
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(
      page.getByRole("heading", { name: /^Welcome/ }),
    ).toBeVisible({ timeout: 15_000 });

    // Now tenant B's own list shows it too — a distinct row from tenant A's.
    await page.goto(`http://${slugB}.localtest.me:3000/admin/members`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(customerEmail)).toBeVisible({ timeout: 15_000 });

    // ── The apex "Your businesses" list surfaces both memberships — the
    // customer's own cross-tenant view, distinct from either tenant's
    // (tenant-scoped) Members list above. ──
    await page.goto("http://localtest.me:3000/portal");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Your businesses")).toBeVisible();
    await expect(
      page.locator(`a[href="http://${slugA}.localtest.me:3000/portal"]`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator(`a[href="http://${slugB}.localtest.me:3000/portal"]`),
    ).toBeVisible();
  });

  test("a tenant-only customer signup is unaffected by the global identity", async ({
    page,
  }) => {
    const { slug } = await signUpNewWorkspace(page);

    const email = faker.internet.email({ provider: "example.com" });
    await page.goto(`http://${slug}.localtest.me:3000/portal/sign-up`);
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await page.getByLabel("Your name").fill("Tenant Only Customer");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByRole("button", { name: /create account/i }).click();

    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/member$`), {
      timeout: 30_000,
    });
    await expect(
      page.getByRole("heading", { name: /^Welcome/ }),
    ).toBeVisible();
  });
});
