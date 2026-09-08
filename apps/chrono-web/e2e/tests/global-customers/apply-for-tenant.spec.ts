import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Global customer identity (agora/customer-auth) — a platform-wide account
 * that self-service "applies" to become a tenant-scoped customer
 * (tenantMember, linked via customerId). See
 * .ai/plans/agora/active/global-customers/README.md.
 *
 * member-visitor-status-tier: visiting a tenant's `/member` alone already
 * creates the tenantMember (silently, as a "visitor" — no lock/prompt to
 * click through). A real application ("pending"/"approved", which the
 * tenant's own Members list surfaces as an "Approve" action) still needs an
 * explicit Apply — done here via a mutating control's inline `UnlockHint`.
 */

async function applyToTenant(page: Page, base: string) {
  await page.goto(`${base}/member/settings`);
  await page.waitForLoadState("networkidle");
  // First visit silently registers a "visitor" tenantMember — the profile
  // save control stays disabled with an inline Apply affordance until an
  // explicit apply promotes it to a real application.
  const saveButton = page.getByRole("button", { name: "Save changes" });
  await expect(saveButton).toBeDisabled({ timeout: 15_000 });
  await page.getByRole("button", { name: "Apply to unlock" }).first().click();
  await expect(saveButton).toBeEnabled({ timeout: 15_000 });
  await page.goto(`${base}/member`);
  await expect(page.getByRole("heading", { name: /^Welcome/ })).toBeVisible({ timeout: 15_000 });
}

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
    // The global sign-up form now lands on /member directly (member-player-route-rename).
    await page.waitForURL(/\/member$/, { timeout: 30_000 });
    await expect(page.getByText("Welcome, Global Test Customer")).toBeVisible();

    // ── Visit tenant A's portal (happy path) ──
    // Since member-visitor-status-tier, a not-yet-applied global customer is
    // silently registered as a "visitor" on first visit — real Chrome
    // (header + nav) and real data render immediately, no lock/takeover.
    // Promoting to a real application ("pending"/"approved") still requires
    // an explicit Apply, which now lives inline next to a locked mutating
    // control (`UnlockHint`) rather than a full-page/section prompt.
    await applyToTenant(page, `http://${slugA}.localtest.me:3000`);

    // ── Cross-tenant isolation: tenant A's owner session is still live —
    // the applied customer shows up in tenant A's Members list. Since
    // member-apply-profile-autocreate, "Join this business" also files a
    // real Chrono membership application (ChronoMemberProfile row), so this
    // applicant now has a profileId and a real pending "Approve" action —
    // not just a bare tenantMember row. (The profile-less-row LEFT JOIN case
    // — a tenantMember with no ChronoMemberProfile — is still covered
    // separately, by customers-members-merge's own "Create customer"
    // scenario in members.spec.ts; that path is unaffected by this change.) ──
    await page.goto(`http://${slugA}.localtest.me:3000/admin/members`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(customerEmail)).toBeVisible({ timeout: 15_000 });
    // Better Auth normalizes stored emails to lowercase, but faker's raw
    // output may be mixed-case — match case-insensitively.
    const tenantARow = page.getByRole("row", {
      name: new RegExp(customerEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"),
    });
    await expect(tenantARow.getByRole("button", { name: "Approve" })).toBeVisible();

    // ── Tenant B: create a second, independent business. ──
    const { slug: slugB } = await signUpNewWorkspace(page);

    // Before applying to B, tenant B's own Members list must NOT show this
    // global customer — the two tenant memberships are fully independent.
    await page.goto(`http://${slugB}.localtest.me:3000/admin/members`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(customerEmail)).not.toBeVisible();

    // ── Apply to tenant B independently (same global identity, no
    // second global sign-up) ──
    await applyToTenant(page, `http://${slugB}.localtest.me:3000`);

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
      page.locator(`a[href="http://${slugA}.localtest.me:3000/member"]`),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.locator(`a[href="http://${slugB}.localtest.me:3000/member"]`),
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
