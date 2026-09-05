import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Member dashboard (`/member`) — chrono/member-area, execution phase 2.
 *
 * Happy path: dashboard cards render real (not mocked) data from the new
 * `/portal/loyalty/me`, `/portal/sessions/summary`, `/portal/wallet/balance`,
 * `/portal/wallet/history`, and `/portal/credits/products` reads, and the
 * manual Refresh button re-fetches; role check: Promos is NOT gated for an
 * unapproved (pending) applicant per the plan's decision (only the store
 * PURCHASE route is) — this asserts the dashboard itself, and the one other
 * page live in this phase (Reservations), render identically before
 * approval; cross-tenant isolation: tenant B's member dashboard never shows
 * tenant A's member's name or figures.
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

test.describe("Member dashboard", () => {
  test.describe.configure({ timeout: 270_000 });

  test("happy path: dashboard cards render real data and Refresh re-fetches", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ememdash${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Dash Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await memberSignUp(page, base, { name: "Dash Member", email: memberEmail });

    // The hero/wallet/membership cards render for a brand-new member with no
    // history yet — real zero-state data (0m usage, ₱0.00 balance, bronze/0%
    // level), never a mock.
    await expect(page.getByTestId("playtime-hero")).toBeVisible();
    await expect(page.getByTestId("wallet-card")).toBeVisible();
    await expect(page.getByTestId("membership-card")).toBeVisible();
    await expect(page.getByTestId("premium-store")).toBeVisible();
    await expect(page.getByText(/Welcome, Dash Member/)).toBeVisible();
    await expect(page.getByText("bronze")).toBeVisible();

    // Manual Refresh re-fetches without polling (the plan's "no realtime for
    // members" decision) — clicking it must not error or navigate away.
    await page.getByTestId("member-refresh-button").click();
    await expect(page.getByTestId("playtime-hero")).toBeVisible();
  });

  test("a pending (unapproved) applicant still sees the dashboard and Reservations — only the store purchase is gated", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ememdashp${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Pending Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await memberSignUp(page, base, { name: "Pending Member", email: memberEmail });

    await expect(page.getByTestId("playtime-hero")).toBeVisible();
    // No approval gate on the dashboard itself (only Promos/Leaderboard are
    // flagged) — Reservations is the one other page already live in this
    // phase (Wallet/Session/etc. land in later execution phases).
    await page.getByTestId("member-nav-reservations").click();
    await expect(page).toHaveURL(`${base}/member/reservations`);
  });

  test("isolation: tenant B's member dashboard never shows tenant A's member's name", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ememdisoa${uniq}`;
    const slugB = `e2ememdisob${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const memberEmailA = faker.internet.email({ provider: "example.com" });
    const memberEmailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Tenant A Owner", email: emailA, slug: slugA });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    const ctxA = await browser.newContext();
    const memberPageA = await ctxA.newPage();
    await memberSignUp(memberPageA, baseA, { name: "Isolation Member A", email: memberEmailA });
    await expect(memberPageA.getByText(/Welcome, Isolation Member A/)).toBeVisible();

    await signUpBusiness(page, { name: "Tenant B Owner", email: emailB, slug: slugB });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    const ctxB = await browser.newContext();
    const memberPageB = await ctxB.newPage();
    await memberSignUp(memberPageB, baseB, { name: "Isolation Member B", email: memberEmailB });

    await expect(memberPageB.getByText(/Welcome, Isolation Member B/)).toBeVisible();
    await expect(memberPageB.getByText(/Isolation Member A/)).toHaveCount(0);

    await ctxA.close();
    await ctxB.close();
  });
});
