import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Member area shell — `/member/*` (tenant-member, physically `(tenant-member)/player`
 * aliased via the `next.config.ts` rewrite — see `member-player-route-rename`).
 *
 * Covers: nav tabs + user menu render, the blanket `/portal → /member` redirect
 * (host-unconditioned since that plan; the value is unchanged, only its
 * mechanism is), the unauthenticated-visitor role gate (→ `/login?next=`), and
 * cross-tenant isolation (tenant B's member session cannot reach tenant A's
 * member area).
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
  await page.goto(`${base}/portal/sign-up`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(`${base}/member`, { timeout: 15_000 });
}

test.describe("Member area shell", () => {
  // Each test here does at least one business sign-up plus a member sign-up
  // cycle, each several DB round-trips against remote Postgres — the
  // isolation test does two of each — so the config's 90s budget is not
  // enough (mirrors auth/tenant-login-paths.spec.ts's own override).
  test.describe.configure({ timeout: 270_000 });

  test("happy path: /portal redirects to /member, nav tabs and user menu render", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2emembsh${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Shell Owner", email: ownerEmail, slug });

    const customerCtx = await page.context().browser()!.newContext();
    const customerPage = await customerCtx.newPage();
    await memberSignUp(customerPage, base, { name: "Shell Member", email: memberEmail });

    // Redirect: /portal → /member — now a blanket, host-unconditioned redirect
    // (next.config.ts), not a tenant-only one; still resolves the same here.
    await customerPage.goto(`${base}/portal`);
    await customerPage.waitForURL(`${base}/member`);

    // Desktop tab bar renders the registry's tabs.
    await expect(customerPage.getByTestId("member-nav-dashboard")).toBeVisible();
    await expect(customerPage.getByTestId("member-nav-reservations")).toBeVisible();
    await expect(customerPage.getByTestId("member-nav-wallet")).toBeVisible();

    // The user menu (IdentityMenu) opens and offers sign-out — the trigger
    // is a bare avatar, so scope to the opened dropdown content rather than
    // a page-wide text match (the dashboard's own "Welcome, Shell Member"
    // heading also contains the name).
    await customerPage.getByTestId("member-user-menu-trigger").click();
    const menu = customerPage.getByRole("menu");
    await expect(menu.getByText("Shell Member", { exact: true })).toBeVisible();
    await expect(menu.getByText(memberEmail)).toBeVisible();

    await customerCtx.close();
  });

  test("role gate: an unauthenticated visitor to /member is sent to /login with ?next=", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ememgate${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Gate Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await page.goto(`${base}/member`);
    await page.waitForURL(/\/login\?next=/, { timeout: 15_000 });
  });

  test("isolation: tenant B's member session cannot reach tenant A's member area", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ememisoa${uniq}`;
    const slugB = `e2ememisob${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const memberEmailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Tenant A Owner", email: emailA, slug: slugA });

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUpBusiness(pageB, { name: "Tenant B Owner", email: emailB, slug: slugB });
    await pageB.getByRole("button", { name: "Sign out" }).click();
    await pageB.waitForLoadState("networkidle");

    const memberCtxB = await browser.newContext();
    const memberPageB = await memberCtxB.newPage();
    await memberSignUp(memberPageB, baseB, { name: "Isolation Member B", email: memberEmailB });

    // Tenant B's member cookie, sent to tenant A's host, resolves to no
    // member (withTenant/getMemberContext is scoped by tenantId) — the gate
    // redirects to A's own /login, never rendering A's member area.
    await memberPageB.goto(`${baseA}/member`);
    await memberPageB.waitForURL(new RegExp(`//${slugA}\\.localtest\\.me:3000/login`), {
      timeout: 15_000,
    });

    await ctxB.close();
    await memberCtxB.close();
  });
});
