import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Dynamic open/closed status (`hoursConfig` → `computeOpenStatus`),
 * `.ai/plans/chrono/in-progress/tenant-experience-v2/README.md` Phase 1a.
 *
 * `computeOpenStatus` is a pure function unit-tested directly in
 * `apps/chrono-api/src/modules/branch/hours.test.ts` — this spec proves the
 * *read path* end to end: a real branch's `hoursConfig`, written through the
 * real `PATCH /rpc/branches/:id` route, surfaces as the correct status on the
 * public `/about` page.
 *
 * Rather than mocking wall-clock time (no time-freeze harness exists in this
 * suite), each case is deliberately time-INDEPENDENT: "every day is 24h" is
 * always open regardless of when the test runs, and "every day is closed" is
 * always closed with no future opening — so the assertions are correct at any
 * moment without controlling `now`.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const SEEDED_PASSWORD = "Password123!";

async function signUp(
  page: import("@playwright/test").Page,
  { name, email, slug }: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });
}

/**
 * Sign-up auto-provisions a default "Main" branch, fire-and-forget, from the
 * root `/admin` dashboard page (`onboarding-defaults.ts`) — `signUp()` above
 * already lands there. Wait for its completion toast before doing anything
 * that depends on the branch existing.
 */
async function waitForMainBranch(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByText(/Set up a default/i)).toBeVisible({ timeout: 15_000 });
}

/**
 * Resolve the id of the tenant's auto-provisioned "Main" branch — the ONE
 * branch `/public/venue-info` (and so `/about`) ever reads (the tenant's
 * first active branch, oldest by `createdAt`, `apps/chrono-api/AGENTS.md`).
 * Every case below patches Main directly rather than creating a second
 * branch, whose hours would never reach that endpoint.
 *
 * This `GET /rpc/branches` goes straight to the API origin (`localhost:8787`),
 * not through the web app's same-origin proxy — so `tenantMiddleware` has no
 * host to resolve a tenant from unless the request carries `x-tenant-slug`
 * explicitly (same as every other cross-origin `page.request` call in this
 * suite, e.g. `signup-default-provisioning.spec.ts`). Without it every such
 * call 401s regardless of the session cookie.
 */
async function getMainBranchId(
  page: import("@playwright/test").Page,
  slug: string,
): Promise<string> {
  const res = await page.request.get(`${API_URL}/rpc/branches`, {
    params: { pageSize: "100" },
    headers: { "x-tenant-slug": slug },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; name: string }[] };
  const branch = body.items.find((b) => b.name === "Main");
  expect(branch).toBeTruthy();
  return branch!.id;
}

const ALL_DAYS_24H = {
  sunday: "24h",
  monday: "24h",
  tuesday: "24h",
  wednesday: "24h",
  thursday: "24h",
  friday: "24h",
  saturday: "24h",
} as const;

const ALL_DAYS_CLOSED = {
  sunday: "closed",
  monday: "closed",
  tuesday: "closed",
  wednesday: "closed",
  thursday: "closed",
  friday: "closed",
  saturday: "closed",
} as const;

test.describe("Dynamic open/closed status", () => {
  test("a branch with 24h hours shows OPEN NOW on the public page", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ehoursopen${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Hours Owner", email, slug });
    await waitForMainBranch(page);
    const branchId = await getMainBranchId(page, slug);

    const patch = await page.request.patch(`${API_URL}/rpc/branches/${branchId}`, {
      headers: { "x-tenant-slug": slug },
      data: { hoursConfig: ALL_DAYS_24H },
    });
    expect(patch.ok()).toBeTruthy();
    await page.context().clearCookies();

    await page.goto(`${base}/about`);
    await page.waitForLoadState("networkidle");

    const status = page.getByTestId("landing-hero-open-status");
    await expect(status).toBeVisible();
    await expect(status).toContainText(/open now/i);
    await expect(page.getByTestId("landing-contact-open-status")).toContainText(/open now/i);
  });

  test("a branch with all days closed shows CLOSED with no fabricated opens-at", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ehoursclosed${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Hours Owner", email, slug });
    await waitForMainBranch(page);
    const branchId = await getMainBranchId(page, slug);

    const patch = await page.request.patch(`${API_URL}/rpc/branches/${branchId}`, {
      headers: { "x-tenant-slug": slug },
      data: { hoursConfig: ALL_DAYS_CLOSED },
    });
    expect(patch.ok()).toBeTruthy();
    await page.context().clearCookies();

    await page.goto(`${base}/about`);
    await page.waitForLoadState("networkidle");

    const status = page.getByTestId("landing-contact-open-status");
    await expect(status).toBeVisible();
    await expect(status).toContainText(/closed/i);
    await expect(status).not.toContainText(/opens at/i);
  });

  test("a branch with no hoursConfig falls back to the legacy operatingHours text", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ehoursnone${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const legacyHours = `test-hours-${uniq}`;

    await signUp(page, { name: "Hours Owner", email, slug });
    await waitForMainBranch(page);
    const branchId = await getMainBranchId(page, slug);

    // Set the legacy free-text field; deliberately never set hoursConfig.
    const patch = await page.request.patch(`${API_URL}/rpc/branches/${branchId}`, {
      headers: { "x-tenant-slug": slug },
      data: { operatingHours: legacyHours },
    });
    expect(patch.ok()).toBeTruthy();
    await page.context().clearCookies();

    await page.goto(`${base}/about`);
    await page.waitForLoadState("networkidle");

    // No computed status anywhere on the page — never a fabricated one.
    await expect(page.getByTestId("landing-hero-open-status")).toHaveCount(0);
    await expect(page.getByTestId("landing-contact-open-status")).toHaveCount(0);
    // The permanent supplementary free-text note still renders exactly as today.
    await expect(page.getByText(legacyHours)).toBeVisible();
  });

  test("cross-tenant isolation: tenant A's hours never leak into tenant B's computed status", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ehoursa${uniq}`;
    const slugB = `e2ehoursb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });

    // Tenant A: always open.
    await signUp(page, { name: "Venue A", email: emailA, slug: slugA });
    await waitForMainBranch(page);
    const branchIdA = await getMainBranchId(page, slugA);
    const patchA = await page.request.patch(`${API_URL}/rpc/branches/${branchIdA}`, {
      headers: { "x-tenant-slug": slugA },
      data: { hoursConfig: ALL_DAYS_24H },
    });
    expect(patchA.ok()).toBeTruthy();

    // Tenant B: always closed, its own separate session.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Venue B", email: emailB, slug: slugB });
    await waitForMainBranch(pageB);
    const branchIdB = await getMainBranchId(pageB, slugB);
    const patchB = await pageB.request.patch(`${API_URL}/rpc/branches/${branchIdB}`, {
      headers: { "x-tenant-slug": slugB },
      data: { hoursConfig: ALL_DAYS_CLOSED },
    });
    expect(patchB.ok()).toBeTruthy();
    await ctxB.close();

    await page.context().clearCookies();

    // Tenant A's own public page reports open — never tenant B's closed status.
    const resA = await page.request.get(`${API_URL}/public/venue-info`, {
      headers: { "x-tenant-slug": slugA },
    });
    expect(resA.status()).toBe(200);
    const bodyA = (await resA.json()) as {
      branch: { openStatus: { isOpen: boolean; opensAt: string | null } | null } | null;
    };
    expect(bodyA.branch?.openStatus?.isOpen).toBe(true);

    // Tenant B's own public page reports closed — never tenant A's open status.
    const resB = await page.request.get(`${API_URL}/public/venue-info`, {
      headers: { "x-tenant-slug": slugB },
    });
    expect(resB.status()).toBe(200);
    const bodyB = (await resB.json()) as {
      branch: { openStatus: { isOpen: boolean; opensAt: string | null } | null } | null;
    };
    expect(bodyB.branch?.openStatus?.isOpen).toBe(false);
  });
});
