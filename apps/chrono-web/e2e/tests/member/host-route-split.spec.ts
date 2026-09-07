import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Host-route split for `/member` — `member-player-route-rename`.
 *
 * Exactly one physical tree may own the `/member` URL in Next's route table
 * (apex: `(saas-member)/member`), so a tenant host reaches its own member
 * area through a `next.config.ts` rewrite to the physically-renamed
 * `(tenant-member)/player` tree. That rewrite carries a negative-lookahead
 * exclusion for the five shared auth pages (login, sign-up, forgot, reset,
 * accept-invite), because foundation-emailed links and OAuth-callback
 * redirects point at `/member/{login,...}` regardless of host.
 *
 * This collision has broken and been reverted twice before (`8fde2bce`,
 * `a07ff5fd`/`e7840131`) — this spec exists so a third regression is caught
 * by CI instead of by a developer.
 */
const PASSWORD = "Password123!";
const APEX = "http://localtest.me:3000";

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
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin(/setup)?$`), {
    timeout: 60_000,
  });
}

async function memberSignUp(
  page: Page,
  base: string,
  { name, email }: { name: string; email: string },
) {
  await page.goto(`${base}/member/sign-up`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(`${base}/member`, { timeout: 15_000 });
}

async function signUpGlobalCustomer(page: Page, name: string) {
  const email = faker.internet.email({ provider: "example.com" });
  await page.goto("/member/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/\/member$/, { timeout: 30_000 });
  return { email };
}

test.describe("Member/player host-route split", () => {
  test.describe.configure({ timeout: 270_000 });

  test("apex /member renders the global portal home; tenant /member renders the member dashboard", async ({
    page,
    browser,
  }) => {
    // Apex: a signed-in global customer's `/member` is the portal home, not
    // the tenant member dashboard and not a redirect to /member/login.
    await signUpGlobalCustomer(page, "Split Global Customer");
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(`${APEX}/member`);
    await expect(page.getByText("Welcome, Split Global Customer")).toBeVisible();
    await expect(page.getByText("Page not found")).toHaveCount(0);

    // Tenant: a signed-in tenant member's `/member` is the member dashboard
    // (physically `(tenant-member)/player`, reached via the rewrite) — a
    // completely different tree from the apex page above, same URL.
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ehostsplit${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    const ownerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    await signUpBusiness(ownerPage, { name: "Split Owner", email: ownerEmail, slug });

    const memberCtx = await browser.newContext();
    const memberPage = await memberCtx.newPage();
    await memberSignUp(memberPage, base, { name: "Split Member", email: memberEmail });
    await expect(memberPage).toHaveURL(`${base}/member`);
    await expect(memberPage.getByTestId("member-nav-dashboard")).toBeVisible();
    await expect(memberPage.getByTestId("member-nav-wallet")).toBeVisible();
    await expect(memberPage.getByText("Page not found")).toHaveCount(0);

    await ownerCtx.close();
    await memberCtx.close();
  });

  test("tenant /member/login serves the login form via the rewrite exclusion, not a 404", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ehostlogin${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Login Split Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // `/member/login` is excluded from the tenant `/member/:path -> /player/:path`
    // rewrite (it would otherwise 404 at a nonexistent `/player/login`). The
    // shared page itself then detects the tenant host and replaces to `/login`,
    // this business's own member sign-in.
    await page.goto(`${base}/member/login`);
    await page.waitForURL(`${base}/login`, { timeout: 15_000 });
    await expect(page.getByText("Customer sign in")).toBeVisible();
    await expect(page.getByText("Page not found")).toHaveCount(0);
  });

  test("apex /member/login serves the global login form, not the staff form", async ({
    page,
  }) => {
    await page.goto(`${APEX}/member/login`);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(`${APEX}/member/login`);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByText("Access your account.")).toBeVisible();
    await expect(page.getByText("Staff sign in")).toHaveCount(0);
    await expect(page.getByText("Page not found")).toHaveCount(0);
  });

  test("tenant /member/accept-invite does not 404 (the no-host-branching case)", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ehostinvite${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Invite Split Owner", email: ownerEmail, slug });

    // `accept-invite/page.tsx` has no host branching at all — reached only via
    // a foundation-emailed link with no host guarantee — so it needs the same
    // rewrite exclusion as the other four shared auth pages, for a different
    // reason (no `/player/accept-invite` tree exists to fall back to).
    await page.goto(`${base}/member/accept-invite`);
    await page.waitForLoadState("networkidle");
    await expect(page).toHaveURL(`${base}/member/accept-invite`);
    await expect(page.getByRole("heading", { name: "You're invited" })).toBeVisible();
    await expect(page.getByText("Page not found")).toHaveCount(0);
  });

  test("/portal redirects to /member on both the apex and a tenant host", async ({ page }) => {
    // Assert the redirect mechanism itself (the next.config.ts rule), not the
    // downstream auth-gate landing spot — an unauthenticated visitor to
    // `/member` on either host client-side-redirects again (to
    // `/member/login` or `/login?next=`, both covered elsewhere), which would
    // make a `waitForURL("…/member")` assertion racy/wrong here. A raw,
    // redirect-following-disabled request isolates just the
    // `/portal -> /member` hop.
    const apexRes = await page.request.get(`${APEX}/portal`, { maxRedirects: 0 });
    expect([307, 308]).toContain(apexRes.status());
    expect(apexRes.headers()["location"]).toBe("/member");

    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ehostredirect${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    const tenantRes = await page.request.get(`${base}/portal`, { maxRedirects: 0 });
    expect([307, 308]).toContain(tenantRes.status());
    expect(tenantRes.headers()["location"]).toBe("/member");
  });
});
