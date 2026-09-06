import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Cross-tenant isolation for `GET /rpc/growth/demand`
 * (.ai/plans/chrono/in-progress/two-sided-growth-loop, Phase 7).
 *
 * **This is the isolation proof for this feature.** `ChronoBusinessLeads` is
 * deliberately NOT under RLS — a lead is captured before the business it names
 * has any tenant, so there is no `tenantId` to scope by — which means
 * `rls:proof` does not and cannot cover this route. The ONLY isolation on it is
 * the server-derived normalized-name predicate, so a regression there would be
 * invisible to every other check in the repo.
 *
 * The same stance the foundation documents for `readPublishedLandingPage`
 * (`packages/agora/src/core/server/routes/landing.ts`): the cross-tenant e2e
 * case is the real proof.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const SEEDED_PASSWORD = "Password123!";

async function signUpBusiness(
  page: Page,
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

/** Sign up a global (platform-wide) customer — the identity a lead requires. */
async function signUpGlobalCustomer(page: Page, email: string) {
  await page.goto("/portal/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.getByLabel("Your name").fill("Growth Isolation Player");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/\/portal$/, { timeout: 30_000 });
}

async function demandCount(
  request: import("@playwright/test").APIRequestContext,
  page: Page,
  slug: string,
): Promise<number> {
  const cookies = await page.context().cookies();
  const res = await request.get(`http://${slug}.localtest.me:3000/rpc/growth/demand`, {
    headers: {
      cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
      "x-tenant-slug": slug,
    },
  });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { count: number }).count;
}

test.describe("Growth demand read — cross-tenant isolation", () => {
  test("a lead naming business A is counted by A and never by B", async ({
    page,
    browser,
    request,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    // The business NAME is what a lead matches on (normalized), so give A a
    // distinctive one that cannot collide with B or with any other test run.
    const slugA = `e2egrowthisoa${uniq}`;
    const slugB = `e2egrowthisob${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const playerEmail = faker.internet.email({ provider: "example.com" });

    // Both businesses are created with `slug` as their display name, so
    // business A's organization name is exactly `slugA`.
    await signUpBusiness(page, { name: "Iso Owner A", email: emailA, slug: slugA });

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUpBusiness(pageB, { name: "Iso Owner B", email: emailB, slug: slugB });

    // Baselines: neither business has been asked for yet.
    expect(await demandCount(request, page, slugA)).toBe(0);
    expect(await demandCount(request, pageB, slugB)).toBe(0);

    // ── A player asks for business A, by name, from the public apex form ──
    const ctxPlayer = await browser.newContext();
    const playerPage = await ctxPlayer.newPage();
    await signUpGlobalCustomer(playerPage, playerEmail);

    const lead = await playerPage.evaluate(
      async ({ apiUrl, businessName }) => {
        const res = await fetch(`${apiUrl}/public/discover/business-leads`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          // Deliberately messy casing/whitespace — the shared normalizer is
          // what makes this match, and a regression there is exactly what this
          // asserts.
          body: JSON.stringify({ businessName: `  ${businessName.toUpperCase()}  ` }),
        });
        return { status: res.status, body: await res.text() };
      },
      { apiUrl: API_URL, businessName: slugA },
    );
    expect(lead.status).toBe(201);
    await ctxPlayer.close();

    // ── A counts it; B never does ──
    expect(
      await demandCount(request, page, slugA),
      "business A should see the lead that names it",
    ).toBe(1);
    expect(
      await demandCount(request, pageB, slugB),
      "business B must NEVER see a lead that names business A",
    ).toBe(0);

    await ctxB.close();
  });
});
