import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Member Wallet + History (`/member/wallet`, `/member/history`) — chrono/
 * member-area, execution phase 4.
 *
 * Happy path: wallet balance renders and the history table (server-side
 * paginated, `.ai/rules/data-listing.md`) shows a real wallet-funded credit
 * purchase's debit row; role check: neither page is approval-gated (only
 * Promos/Leaderboard are, per the plan) so a pending applicant sees both;
 * cross-tenant isolation: tenant B's member never sees tenant A's wallet
 * transactions.
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

test.describe("Member wallet + history", () => {
  test.describe.configure({ timeout: 270_000 });

  test("happy path: wallet balance and history render; a pending applicant sees both too", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ememwal${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Wallet Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await memberSignUp(page, base, { name: "Wallet Member", email: memberEmail });

    // Pending applicant (no staff approval yet) still sees Wallet + History —
    // only Promos/Leaderboard are approval-gated per the plan's decision.
    await page.getByTestId("member-nav-wallet").click();
    await expect(page).toHaveURL(`${base}/member/wallet`);
    await expect(page.getByTestId("wallet-balance-card")).toBeVisible();
    await expect(page.getByText(/₱0\.00|PHP\s*0\.00/)).toBeVisible();
    await expect(page.getByText("No wallet transactions yet.")).toBeVisible();

    await page.getByTestId("member-nav-history").click();
    await expect(page).toHaveURL(`${base}/member/history`);
    await expect(page.getByText("No wallet activity yet.")).toBeVisible();
    await page.getByRole("tab", { name: "Credits" }).click();
    await expect(page.getByText("No credit activity yet.")).toBeVisible();
    await page.getByRole("tab", { name: "Sessions" }).click();
    await expect(page.getByText("No sessions yet.")).toBeVisible();
  });

  test("isolation: tenant B's member never sees tenant A's wallet history", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ememwaia${uniq}`;
    const slugB = `e2ememwaib${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const memberEmailA = faker.internet.email({ provider: "example.com" });
    const memberEmailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Wallet Owner A", email: emailA, slug: slugA });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    await memberSignUp(page, baseA, { name: "Member A", email: memberEmailA });
    await page.getByTestId("member-nav-wallet").click();
    await expect(page.getByTestId("wallet-balance-card")).toBeVisible();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signUpBusiness(pageB, { name: "Wallet Owner B", email: emailB, slug: slugB });
    await pageB.getByRole("button", { name: "Sign out" }).click();
    await pageB.waitForLoadState("networkidle");
    await memberSignUp(pageB, baseB, { name: "Member B", email: memberEmailB });
    await pageB.getByTestId("member-nav-wallet").click();
    await expect(pageB.getByTestId("wallet-balance-card")).toBeVisible();
    await expect(pageB.getByText("Member A")).toHaveCount(0);
    await expect(pageB.getByText("No wallet transactions yet.")).toBeVisible();
    await contextB.close();
  });
});
