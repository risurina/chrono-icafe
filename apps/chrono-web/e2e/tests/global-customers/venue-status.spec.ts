import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Live open/closed + availability on "My Gaming Spots" (member-portal-v2
 * plan Phase 7) — `apps/chrono-api/src/modules/station/customer-portal-routes.ts`
 * (`GET /portal/customer/venues`), merged client-side into
 * `global-portal-home.tsx` alongside the foundation's own
 * `GET /portal/customer/memberships`.
 *
 * Covers: happy path (a global customer with 2+ tenant memberships sees the
 * correct per-venue status/availability) and cross-tenant isolation (tenant
 * A's station count must never leak into tenant B's badge or vice versa).
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const SEEDED_PASSWORD = "Password123!";

async function signUpNewWorkspace(page: Page): Promise<{ slug: string }> {
  const uniq = faker.string.alphanumeric({ length: 8, casing: "lower" });
  const slug = `test-${uniq}`;
  const email = faker.internet.email({ provider: "example.com" });

  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);

  await page.getByLabel("Your name").fill(faker.person.fullName());
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Business name").fill(slug);

  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });

  return { slug };
}

/** The auto-provisioned "Main" branch's id (signup-default-provisioning). */
async function findMainBranchId(page: Page, slug: string): Promise<string> {
  let branchId: string | null = null;
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`${API_URL}/rpc/branches`, {
          params: { pageSize: "10" },
          headers: { "x-tenant-slug": slug },
        });
        if (!res.ok()) return null;
        const items = (await res.json()).items as Array<{ id: string }>;
        branchId = items[0]?.id ?? null;
        return branchId;
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
  return branchId!;
}

/** Creates one station (default status "available") for the given tenant. */
async function createAvailableStation(page: Page, slug: string, branchId: string) {
  const res = await page.request.post(`${API_URL}/rpc/stations`, {
    data: { branchId, name: "PC-01", stationNumber: "001" },
    headers: { "x-tenant-slug": slug },
  });
  expect(res.ok()).toBeTruthy();
}

async function signUpGlobalCustomer(page: Page): Promise<{ email: string }> {
  const email = faker.internet.email({ provider: "example.com" });
  await page.goto("/portal/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.getByLabel("Your name").fill("Venue Status Customer");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  // The global sign-up form now lands on /member directly (member-player-route-rename).
  await page.waitForURL(/\/member$/, { timeout: 30_000 });
  return { email };
}

/** Applies the signed-in global customer to a tenant via its own `/member`.
 * Since member-portal-guest-preview-banner, a not-yet-applied guest sees the
 * normal Chrome with a "not-applied" MemberAccessBanner (not the old
 * full-page ApplyForTenantPrompt takeover) — the Apply button lives there. */
async function applyToTenant(page: Page, slug: string) {
  await page.goto(`http://${slug}.localtest.me:3000/member`);
  await page.waitForLoadState("networkidle");
  await expect(
    page.getByText("Join this business — apply to become a customer to unlock your account."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("heading", { name: /^Welcome/ })).toBeVisible({ timeout: 15_000 });
}

test.describe("My Gaming Spots — live venue status", () => {
  test("shows each venue's own open/closed + availability, never the other's", async ({
    page,
  }) => {
    // ── Tenant A: one available station. ──
    const { slug: slugA } = await signUpNewWorkspace(page);
    const branchIdA = await findMainBranchId(page, slugA);
    await createAvailableStation(page, slugA, branchIdA);

    // ── Tenant B: no stations at all (auto-provisioned branch only). ──
    const { slug: slugB } = await signUpNewWorkspace(page);

    // ── Global customer applies to both. ──
    await signUpGlobalCustomer(page);
    await applyToTenant(page, slugA);
    await applyToTenant(page, slugB);

    // ── "My Gaming Spots" (apex /portal) shows both, each with its OWN
    // status — this is the real cross-tenant-isolation assertion: A's one
    // available station must never bleed into B's row, and B's zero
    // stations must never zero out A's. ──
    await page.goto("http://localtest.me:3000/portal");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Your businesses")).toBeVisible();

    // Scope to each row's own container (the closest ancestor div carrying
    // its `justify-between` layout class) — the plain `div` role/text
    // locators below would otherwise match every ancestor wrapper too.
    const rowA = page
      .locator(`a[href="http://${slugA}.localtest.me:3000/member"]`)
      .locator("xpath=ancestor::div[contains(@class,'justify-between')][1]");
    await expect(rowA.getByText("Open", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(rowA.getByText("1/1 available")).toBeVisible();

    const rowB = page
      .locator(`a[href="http://${slugB}.localtest.me:3000/member"]`)
      .locator("xpath=ancestor::div[contains(@class,'justify-between')][1]");
    await expect(rowB.getByText("Closed", { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(rowB.getByText("0/0 available")).toBeVisible();

    // Never the other way around.
    await expect(rowA.getByText("Closed", { exact: true })).toHaveCount(0);
    await expect(rowA.getByText("0/0 available")).toHaveCount(0);
    await expect(rowB.getByText("Open", { exact: true })).toHaveCount(0);
    await expect(rowB.getByText("1/1 available")).toHaveCount(0);
  });
});
