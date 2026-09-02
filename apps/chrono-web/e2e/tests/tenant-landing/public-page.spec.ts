import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Public `/about` page coverage for the tenant-landing module
 * (chrono/tenant-landing), Phase 5 of
 * .ai/plans/chrono/active/tenant-landing/README.md.
 *
 * - Happy path: as owner, save landing-page content via the settings editor;
 *   visit /about unauthenticated and confirm it renders.
 * - Tenant isolation: tenant A's content never appears on tenant B's /about,
 *   even when both tenants have content configured.
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
  await page.getByLabel("Workspace name").fill(slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function saveLandingPage(
  page: import("@playwright/test").Page,
  base: string,
  content: { heroTagline: string; aboutBody: string; amenitiesBody: string },
) {
  await page.goto(`${base}/dashboard/settings/landing-page`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Hero tagline").fill(content.heroTagline);
  await page.getByLabel("About").fill(content.aboutBody);
  await page.getByLabel("Amenities").fill(content.amenitiesBody);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Landing page updated.")).toBeVisible();
}

test.describe("Tenant landing — public page", () => {
  test("happy path: save content as owner, /about renders it unauthenticated", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2elanding${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Landing Owner", email: ownerEmail, slug });

    const heroTagline = faker.company.catchPhrase();
    const aboutBody = faker.lorem.paragraph();
    const amenitiesBody = faker.lorem.sentence();
    await saveLandingPage(page, base, { heroTagline, aboutBody, amenitiesBody });

    // Visit /about unauthenticated (fresh context, no session cookie).
    const ctxAnon = await browser.newContext();
    const pageAnon = await ctxAnon.newPage();
    await pageAnon.goto(`${base}/about`);
    await pageAnon.waitForLoadState("networkidle");

    await expect(pageAnon.getByText(heroTagline)).toBeVisible();
    await expect(pageAnon.getByText(aboutBody)).toBeVisible();
    await expect(pageAnon.getByText(amenitiesBody)).toBeVisible();
    await ctxAnon.close();
  });

  test("tenant isolation: tenant A's landing content never appears on tenant B's /about", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slugA = `e2elandinga${uniq}`;
    const slugB = `e2elandingb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    // Tenant A saves distinctive content.
    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });
    const heroTaglineA = `${faker.company.catchPhrase()} — tenant A only`;
    const aboutBodyA = faker.lorem.paragraph();
    await saveLandingPage(page, baseA, {
      heroTagline: heroTaglineA,
      aboutBody: aboutBodyA,
      amenitiesBody: faker.lorem.sentence(),
    });
    await page.context().clearCookies();

    // Tenant B saves its own, different content.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });
    const heroTaglineB = `${faker.company.catchPhrase()} — tenant B only`;
    await saveLandingPage(pageB, baseB, {
      heroTagline: heroTaglineB,
      aboutBody: faker.lorem.paragraph(),
      amenitiesBody: faker.lorem.sentence(),
    });

    // Tenant B's public page shows only tenant B's content, never A's.
    const ctxAnon = await browser.newContext();
    const pageAnon = await ctxAnon.newPage();
    await pageAnon.goto(`${baseB}/about`);
    await pageAnon.waitForLoadState("networkidle");
    await expect(pageAnon.getByText(heroTaglineB)).toBeVisible();
    await expect(pageAnon.getByText(heroTaglineA)).toHaveCount(0);
    await ctxAnon.close();
    await ctxB.close();
  });
});
