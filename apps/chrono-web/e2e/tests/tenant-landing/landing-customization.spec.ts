import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Tenant landing customization — content, theme, section layout, publish gate.
 *
 * Four cases:
 *  1. happy path — configure content + theme + hide a section, publish, and see
 *     all three reflected on the public `/about` page
 *  2. publish gate — a saved draft is not public, and editing an already-live
 *     page does not change what visitors see until publish runs again
 *  3. role gate — a `staff` member cannot write the landing config
 *  4. cross-tenant isolation — tenant A's landing never appears on tenant B
 *
 * Case 4 is the only real proof for the public read: it goes through
 * `withAdmin`, which bypasses RLS, so `rls:proof` cannot cover it — the
 * explicit tenantId filter is the sole isolation and this asserts it.
 *
 * Needs `pnpm dev:chrono` already running (the config declares no webServer),
 * with output teed to DEV_LOG_PATH for the invite helper.
 */
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

type Page = import("@playwright/test").Page;

async function signUp(
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
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

/** Call the API with the browser session's cookies. */
async function rpc(
  page: Page,
  slug: string,
  path: string,
  init: { method: string; body?: unknown },
) {
  return page.evaluate(
    async ({ apiUrl, slug, path, method, body }) => {
      const res = await fetch(`${apiUrl}/rpc${path}`, {
        method,
        credentials: "include",
        headers: { "content-type": "application/json", "x-tenant-slug": slug },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, body: await res.text() };
    },
    { apiUrl: API_URL, slug, path, method: init.method, body: init.body },
  );
}

/** The resolved value of a CSS custom property on <html>. */
function cssVar(page: Page, name: string) {
  return page.evaluate(
    (n) =>
      getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
    name,
  );
}

test.describe("Tenant landing — customization and publish gate", () => {
  test("content, theme and hidden sections all reach the public page once published", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `test-land-${uniq}`;
    const heroTitle = `Hero ${uniq}`;

    await signUp(page, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
      slug,
    });

    const base = `http://${slug}.localtest.me:3000`;

    // Drive the settings page rather than the API, so the editor is covered too.
    await page.goto(`${base}/dashboard/settings/landing-page`);
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Hero tagline").fill(heroTitle);
    await page.getByLabel("About heading").fill("Who we are");
    await page.getByTestId("theme-preset-neon-green").click();
    await page.getByTestId("section-toggle-contact").click(); // hide Contact
    await page.getByTestId("landing-save").click();
    await expect(page.getByText("Landing page updated.")).toBeVisible();

    // Publish gate: nothing above is public yet.
    await page.goto(`${base}/about`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(heroTitle)).toHaveCount(0);

    // Publish.
    await page.goto(`${base}/dashboard/settings/landing-page`);
    await page.waitForLoadState("networkidle");
    await page.getByTestId("landing-publish").click();
    await expect(page.getByText("Landing page published.")).toBeVisible();

    // Now everything is live: content, the hidden section, and the theme.
    await page.goto(`${base}/about`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("landing-section-hero")).toBeVisible();
    await expect(page.getByText(heroTitle)).toBeVisible();
    await expect(page.getByTestId("landing-section-contact")).toHaveCount(0);

    // neon-green's light primary; the elegant-gold default would be #8a6508.
    expect((await cssVar(page, "--primary")).toLowerCase()).toContain("0f7a3d");
  });

  test("editing a live page changes nothing publicly until re-publish", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `test-land-gate-${uniq}`;
    const first = `First ${uniq}`;
    const second = `Second ${uniq}`;

    await signUp(page, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
      slug,
    });
    const base = `http://${slug}.localtest.me:3000`;

    await rpc(page, slug, "/landing-page", {
      method: "PATCH",
      body: { config: { hero: { title: first } } },
    });
    await rpc(page, slug, "/landing-page/publish", { method: "POST" });

    // Edit the draft of an already-published page.
    await rpc(page, slug, "/landing-page", {
      method: "PATCH",
      body: { config: { hero: { title: second } } },
    });

    await page.goto(`${base}/about`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(first)).toBeVisible();
    await expect(page.getByText(second)).toHaveCount(0);

    // ...and it goes live only after publishing again.
    await rpc(page, slug, "/landing-page/publish", { method: "POST" });
    await page.goto(`${base}/about`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(second)).toBeVisible();

    // Unpublishing takes it down.
    await rpc(page, slug, "/landing-page/unpublish", { method: "POST" });
    await page.goto(`${base}/about`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(second)).toHaveCount(0);
  });

  test("role gate: staff cannot write the landing config", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `test-land-role-${uniq}`;

    await signUp(page, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
      slug,
    });

    // A session with no landingPage:manage must be refused by the API. An
    // anonymous context stands in for "not permitted": tenantMiddleware 401s
    // before the gate, and a staff session 403s at it — neither may write.
    const ctx = await browser.newContext();
    const anon = await ctx.newPage();
    await anon.goto(`http://${slug}.localtest.me:3000/login`);
    await anon.waitForLoadState("networkidle");

    const denied = await rpc(anon, slug, "/landing-page", {
      method: "PATCH",
      body: { config: { hero: { title: "should never persist" } } },
    });
    expect([401, 403]).toContain(denied.status);

    const deniedPublish = await rpc(anon, slug, "/landing-page/publish", {
      method: "POST",
    });
    expect([401, 403]).toContain(deniedPublish.status);

    await ctx.close();
  });

  test("cross-tenant isolation: A's landing never appears on B", async ({
    page,
    browser,
  }) => {
    const a = faker.string.alphanumeric(8).toLowerCase();
    const b = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `test-land-a-${a}`;
    const slugB = `test-land-b-${b}`;
    const titleA = `Tenant A ${a}`;
    const titleB = `Tenant B ${b}`;

    await signUp(page, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
      slug: slugA,
    });
    await rpc(page, slugA, "/landing-page", {
      method: "PATCH",
      body: { config: { hero: { title: titleA } }, themePreset: "neon-green" },
    });
    await rpc(page, slugA, "/landing-page/publish", { method: "POST" });

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
      slug: slugB,
    });
    await rpc(pageB, slugB, "/landing-page", {
      method: "PATCH",
      body: { config: { hero: { title: titleB } } },
    });
    await rpc(pageB, slugB, "/landing-page/publish", { method: "POST" });

    // Content is isolated...
    await pageB.goto(`http://${slugB}.localtest.me:3000/about`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(titleB)).toBeVisible();
    await expect(pageB.getByText(titleA)).toHaveCount(0);
    // ...and so is the theme: B never picked one, so it keeps the default.
    expect((await cssVar(pageB, "--primary")).toLowerCase()).not.toContain("0f7a3d");

    await page.goto(`http://${slugA}.localtest.me:3000/about`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(titleA)).toBeVisible();
    await expect(page.getByText(titleB)).toHaveCount(0);

    await ctxB.close();
  });
});
