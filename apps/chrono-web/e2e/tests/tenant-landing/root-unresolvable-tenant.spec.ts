import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * The tenant-host root `/` and the true apex `/` are two different pages behind
 * one file, and this spec pins BOTH directions of that split.
 *
 * Before this plan, a subdomain that resolved to no workspace silently rendered
 * the generic Chrono marketing page AT THAT SUBDOMAIN'S URL — `fetchTenant()`
 * returned `null` for an unknown tenant exactly as it does for a real apex
 * visit, so the two collapsed into one branch. `/about` already 404'd the same
 * case; the root page now matches it.
 *
 * The second test is the guard against that fix over-correcting: a 404 rule
 * written too broadly would take the real apex marketing page down with it.
 */
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

test.describe("Tenant landing — unresolvable tenant at the root", () => {
  test("a subdomain that resolves to no workspace 404s at `/`, exactly like `/about`", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const unknownSlug = `e2enosuchtenant${uniq}`;
    const base = `http://${unknownSlug}.localtest.me:3000`;

    const rootRes = await page.goto(`${base}/`);
    expect(rootRes?.status()).toBe(404);

    // The regression itself: the generic apex marketing page must NOT be what
    // an unknown tenant's root renders.
    await expect(page.getByText("Station Session Control")).toHaveCount(0);

    // `/about` behaved correctly all along — asserted here so the two surfaces
    // are pinned as a matched pair rather than drifting apart again.
    const aboutRes = await page.goto(`${base}/about`);
    expect(aboutRes?.status()).toBe(404);
  });

  test("the true apex host still renders the generic marketing page", async ({ page }) => {
    // Not a tenant host — no subdomain. This is the branch the 404 fix must
    // leave completely alone.
    const res = await page.goto("http://localtest.me:3000/");
    expect(res?.status()).toBe(200);
    await page.waitForLoadState("networkidle");

    // "Station Session Control" renders twice on the apex page (a hero chip and
    // a highlights card title), so `getByText` resolves to two nodes and a bare
    // `toBeVisible()` trips Playwright's strict mode. The `toHaveCount(0)`
    // assertions on the same string elsewhere in this file are unaffected —
    // count assertions do not enforce strictness.
    await expect(page.getByText("Station Session Control").first()).toBeVisible();
    await expect(page.getByText("Manual tracking gets messy")).toBeVisible();

    // The apex is not a tenant, so none of the tenant-only sections render.
    await expect(page.getByTestId("landing-section-playerCta")).toHaveCount(0);
    await expect(page.getByTestId("landing-section-share")).toHaveCount(0);
  });

  test("a real tenant's `/` still renders — an existing workspace is never 404'd", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2erealtenant${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: slug, email, slug });
    await page.context().clearCookies();

    const res = await page.goto(`${base}/`);
    expect(res?.status()).toBe(200);
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("landing-section-hero")).toBeVisible();
    await expect(page.getByText("Station Session Control")).toHaveCount(0);
  });
});
