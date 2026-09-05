import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Smoke coverage for the shared `AuthPageChrome` header/footer applied to
 * Chrono's auth pages (`.ai/plans/chrono/active/auth-page-header-footer/`,
 * mirroring `apps/agora-web/e2e/tests/auth/header-footer.spec.ts`).
 *
 * Not a tenant-scoped-feature e2e spec in the `.ai/rules/e2e-testing.md`
 * sense (no new table/route/RLS surface) — this is presentation chrome
 * reused across already-covered auth flows. Three cases: apex chrome, tenant
 * `/login` (member form) chrome, and tenant `/admin/login` (staff form)
 * chrome — each asserting the href overrides this plan added
 * (`staffLoginHref`/`customerLoginHref`) point at the right route, since
 * Chrono's tenant-host staff sign-in lives at `/admin/login` and its
 * tenant-host customer sign-in is `/login` itself (see
 * `apps/chrono-api/AGENTS.md`, "Surfaces").
 *
 * Runs against the real dev servers (web :3000 + api :8787); needs `pnpm dev`
 * already running (the config declares no `webServer`).
 */
const PASSWORD = "Password123!";

async function signUpBusiness(
  page: Page,
  { name, email, slug }: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Business name").fill(slug); // slug auto-derives
  await page.getByRole("button", { name: /create business/i }).click();
  // A fresh business lands on its back office at /admin (or the setup wizard under it).
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin(/setup)?$`), {
    timeout: 60_000,
  });
}

test.describe("Auth page chrome", () => {
  test("apex /login shows the marketing header and footer", async ({ page }) => {
    await page.goto("/login");

    await expect(
      page.getByRole("link", { name: "Get started" }),
    ).toBeVisible();
    await expect(
      page.getByText(/© \d{4} Chrono\. All rights reserved\./),
    ).toBeVisible();
  });

  test("tenant /login (member form) shows tenant chrome; the header's staff-sign-in action points at /admin/login, never back at /login", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2echromemem${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });

    await signUpBusiness(page, { name: "Chrome Owner", email, slug });

    // Fresh, signed-out context — chrome must not depend on the owner's
    // just-created staff session.
    const ctx = await browser.newContext();
    const tenantPage = await ctx.newPage();
    await tenantPage.goto(`http://${slug}.localtest.me:3000/login`);

    await expect(tenantPage.getByText("Customer sign in")).toBeVisible();
    // The member form itself also links to "Staff sign in" — scope to the
    // header landmark so this asserts the chrome's own action, not the
    // form's.
    await expect(
      tenantPage.getByRole("banner").getByRole("link", { name: "Staff sign in" }),
    ).toHaveAttribute("href", "/admin/login");
    await expect(
      tenantPage.getByText(new RegExp(`© \\d{4} ${slug}`)),
    ).toBeVisible();

    await ctx.close();
  });

  test("tenant /admin/login (staff form) shows tenant chrome; the header's customer sign-in action points at /login", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2echromeadm${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });

    await signUpBusiness(page, { name: "Chrome Owner", email, slug });

    const ctx = await browser.newContext();
    const tenantPage = await ctx.newPage();
    await tenantPage.goto(`http://${slug}.localtest.me:3000/admin/login`);

    await expect(
      tenantPage.getByRole("heading", { name: "Staff sign in" }),
    ).toBeVisible();
    // The form's own link says "Customer sign in"; the header's says
    // exactly "Sign in" — exact match keeps them distinct.
    await expect(
      tenantPage.getByRole("link", { name: "Sign in", exact: true }),
    ).toHaveAttribute("href", "/login");
    await expect(
      tenantPage.getByText(new RegExp(`© \\d{4} ${slug}`)),
    ).toBeVisible();

    await ctx.close();
  });
});
