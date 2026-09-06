import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * `/discover` — search, the anti-dead-end empty state, and the invite flow
 * (.ai/plans/chrono/in-progress/two-sided-growth-loop, Phase 7).
 *
 * Covers the three things most likely to regress:
 *  1. only an AFFIRMATIVELY PUBLISHED business is listed — publishing is the
 *     tenant's consent to appear in a public cross-tenant directory, and an
 *     unpublished business leaking into it is a disclosure bug, not a display
 *     bug;
 *  2. a search that finds nothing never dead-ends — it opens the invite form
 *     with the typed name already filled in;
 *  3. a signed-out submit shows the inline prompt and keeps what was typed,
 *     rather than redirecting to a login that would discard it.
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

/** Publish the tenant's landing page — the directory's consent signal. */
async function publishLandingPage(page: Page, slug: string) {
  const res = await page.evaluate(
    async ({ apiUrl, slug }) => {
      const r = await fetch(`${apiUrl}/rpc/landing-page/publish`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
      });
      return { status: r.status, body: await r.text() };
    },
    { apiUrl: API_URL, slug },
  );
  expect([200, 201]).toContain(res.status);
}

async function search(page: Page, q: string) {
  await page.getByTestId("discover-search-input").fill(q);
  await page.getByTestId("discover-search-submit").click();
  await page.waitForLoadState("networkidle");
}

test.describe("Discover — search, empty state, and invite", () => {
  test("published businesses are listed, unpublished are not, and a miss opens the invite form", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const listedSlug = `e2ediscoveron${uniq}`;
    const hiddenSlug = `e2ediscoveroff${uniq}`;
    const listedEmail = faker.internet.email({ provider: "example.com" });
    const hiddenEmail = faker.internet.email({ provider: "example.com" });

    // ── A published business (consents to being listed) ──
    await signUpBusiness(page, {
      name: "Listed Owner",
      email: listedEmail,
      slug: listedSlug,
    });
    await publishLandingPage(page, listedSlug);

    // ── A business that never publishes (must stay invisible) ──
    const ctxHidden = await browser.newContext();
    const hiddenPage = await ctxHidden.newPage();
    await signUpBusiness(hiddenPage, {
      name: "Hidden Owner",
      email: hiddenEmail,
      slug: hiddenSlug,
    });
    await ctxHidden.close();

    // ── Browse anonymously: /discover is public ──
    const ctxAnon = await browser.newContext();
    const anon = await ctxAnon.newPage();
    await anon.goto("/discover");
    await anon.waitForLoadState("networkidle");

    // 1. The published business is found.
    await search(anon, listedSlug);
    await expect(anon.getByTestId("discover-result")).toHaveCount(1);
    await expect(anon.getByText(listedSlug, { exact: false }).first()).toBeVisible();

    // 2. The unpublished business is NOT found — it never consented to the
    //    directory. This is the disclosure assertion, not a cosmetic one.
    await search(anon, hiddenSlug);
    await expect(anon.getByTestId("discover-result")).toHaveCount(0);
    await expect(anon.getByTestId("discover-empty-state")).toBeVisible();

    // 3. A miss never dead-ends: the invite form opens, pre-filled.
    const inviteForm = anon.getByTestId("discover-invite-form");
    await expect(inviteForm).toBeVisible();
    await expect(anon.getByLabel("Café / business name")).toHaveValue(hiddenSlug);

    // 4. Signed out, submitting shows the inline prompt — and keeps the typed
    //    name. A redirect to /portal/login would discard it (that form ignores
    //    ?next=), which is the dead end this design avoids.
    await anon.getByRole("button", { name: /invite this café/i }).click();
    await expect(anon.getByTestId("discover-invite-signin-prompt")).toBeVisible();
    await expect(anon.getByLabel("Café / business name")).toHaveValue(hiddenSlug);
    expect(anon.url()).toContain("/discover");

    await ctxAnon.close();
  });

  test("a signed-in player's invite creates a real lead", async ({ page, browser }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const wantedName = `Neon Arcade ${uniq}`;
    const playerEmail = faker.internet.email({ provider: "example.com" });

    // A business that will later claim this name, so the lead is verifiable
    // through the product's own read path rather than a direct DB peek.
    const claimSlug = `e2ediscoverclaim${uniq}`;
    const claimEmail = faker.internet.email({ provider: "example.com" });

    // ── Player signs up and invites a business that does not exist yet ──
    await page.goto("/portal/sign-up");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await page.getByLabel("Your name").fill("Discover Player");
    await page.getByLabel("Email").fill(playerEmail);
    await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: /create account/i }).click();
    await page.waitForURL(/\/portal$/, { timeout: 30_000 });

    await page.goto("/discover?invite=1");
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("discover-invite-form")).toBeVisible();
    await page.getByLabel("Café / business name").fill(wantedName);
    await page.getByRole("button", { name: /invite this café/i }).click();

    // Honest copy: the request is recorded, not forwarded — nothing notifies
    // the business in this version.
    await expect(page.getByText(/we've recorded your request/i)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByTestId("discover-invite-signin-prompt")).toHaveCount(0);

    // ── The lead is real: a business created under that exact name sees it ──
    const ctxBiz = await browser.newContext();
    const bizPage = await ctxBiz.newPage();
    await signUpBusiness(bizPage, {
      name: "Claimer",
      email: claimEmail,
      slug: claimSlug,
    });

    // The demand read matches on the ORGANIZATION NAME, so rename the business
    // to the name the player asked for, then read the count back.
    const renamed = await bizPage.evaluate(
      async ({ apiUrl, slug, name }) => {
        const r = await fetch(`${apiUrl}/rpc/organization`, {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json", "x-tenant-slug": slug },
          body: JSON.stringify({ name }),
        });
        return r.status;
      },
      { apiUrl: API_URL, slug: claimSlug, name: wantedName },
    );
    expect(renamed).toBe(200);

    const demand = await bizPage.evaluate(
      async ({ apiUrl, slug }) => {
        const r = await fetch(`${apiUrl}/rpc/growth/demand`, {
          credentials: "include",
          headers: { "x-tenant-slug": slug },
        });
        return { status: r.status, body: await r.json() };
      },
      { apiUrl: API_URL, slug: claimSlug },
    );
    expect(demand.status).toBe(200);
    expect((demand.body as { count: number }).count).toBe(1);

    // And the dashboard banner surfaces it to the owner.
    await bizPage.goto(`http://${claimSlug}.localtest.me:3000/admin`);
    await bizPage.waitForLoadState("networkidle");
    await expect(bizPage.getByTestId("growth-demand-banner")).toBeVisible();

    await ctxBiz.close();
  });
});
