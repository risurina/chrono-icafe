import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Smoke coverage for the shared `AuthPageChrome` header/footer applied to
 * Chrono's auth pages (`.ai/plans/chrono/archive/auth-page-header-footer/`,
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
 * The header and footer assertions target Chrono's own rich
 * `MarketingHeader`/`TenantHeader` and `MarketingFooter`/`TenantFooter` (full
 * nav, brand lockup, CTA; nav columns, "Powered by Chrono"/"Powered by IZUR"
 * bottom bar) — a scope addition found via live testing after the plan's
 * original phases shipped: auth pages must reuse the same header/footer as
 * the public marketing/tenant-landing pages, not `AuthPageChrome`'s generic
 * built-ins. Assert the rich chrome's identifying content, not the old
 * generic text, so this spec would fail if that reuse ever regressed.
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
  test("apex /login shows the same rich MarketingHeader/MarketingFooter as the apex landing page", async ({
    page,
  }) => {
    await page.goto("/login");

    // MarketingHeader's identifying content — its full marketing nav and CTA
    // — not the old generic brand+actions bar. MarketingFooter's own
    // "Platform" column repeats "Features"/"Pricing", so scope to the header
    // landmark.
    const header = page.getByRole("banner");
    await expect(header.getByRole("link", { name: "Discover" })).toBeVisible();
    await expect(header.getByRole("link", { name: "Pricing" })).toBeVisible();
    // The single primary nav CTA. It replaced "Request Private Demo" when the
    // marketing surface was repositioned around two audiences — the nav no
    // longer picks one, and the player/partner split lives in the hero it
    // anchors to.
    await expect(
      header.getByRole("link", { name: "Join Chrono" }),
    ).toBeVisible();
    // MarketingFooter's identifying content — nav columns plus its
    // "Powered by IZUR" bottom bar — not the old generic one-liner.
    await expect(
      page.getByRole("heading", { name: "Platform" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Location" }),
    ).toBeVisible();
    await expect(page.getByText("Powered by IZUR")).toBeVisible();
  });

  test("tenant /login (member form) shows tenant chrome and the same rich TenantFooter as the tenant landing page; the header's staff-sign-in action points at /admin/login, never back at /login", async ({
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
    // TenantHeader's identifying content — its tenant nav anchors — not the
    // old generic brand+actions bar.
    await expect(
      tenantPage.getByRole("banner").getByRole("link", { name: "Rates" }),
    ).toBeVisible();
    // TenantHeader's own staff-sign-in action is a plain "Staff" link
    // (distinct from the member form's own "Staff sign in" link) — always
    // pointed at /admin/login, since TenantHeader is Chrono's own component
    // built for Chrono's own route topology.
    await expect(
      tenantPage.getByRole("banner").getByRole("link", { name: "Staff", exact: true }),
    ).toHaveAttribute("href", "/admin/login");
    // TenantFooter's identifying content — the "Navigation"/"Hours" columns
    // and its "Powered by Chrono" bottom bar — not the old generic
    // `AuthPageChrome` one-liner.
    await expect(
      tenantPage.getByRole("heading", { name: "Navigation" }),
    ).toBeVisible();
    await expect(
      tenantPage.getByRole("heading", { name: "Hours" }),
    ).toBeVisible();
    await expect(tenantPage.getByText("Powered by Chrono")).toBeVisible();
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
    // TenantHeader's identifying content — its tenant nav anchors.
    await expect(
      tenantPage.getByRole("banner").getByRole("link", { name: "Rates" }),
    ).toBeVisible();
    // TenantHeader's own customer-sign-in CTA reads "Member login" at this
    // viewport width (the "Sign in" span is the `sm:hidden` mobile variant) —
    // always pointed at /login, since TenantHeader is Chrono's own component
    // built for Chrono's own route topology.
    await expect(
      tenantPage.getByRole("banner").getByRole("link", { name: "Member login" }),
    ).toHaveAttribute("href", "/login");
    // Same rich TenantFooter as the member-form case above.
    await expect(
      tenantPage.getByRole("heading", { name: "Navigation" }),
    ).toBeVisible();
    await expect(tenantPage.getByText("Powered by Chrono")).toBeVisible();
    await expect(
      tenantPage.getByText(new RegExp(`© \\d{4} ${slug}`)),
    ).toBeVisible();

    await ctx.close();
  });
});
