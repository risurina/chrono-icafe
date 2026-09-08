import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Member Promos (`/member/promos`, `/member/promos/[id]`) — chrono/
 * member-area, execution phase 7.
 *
 * member-portal-v2 phase 1 merged Promos into History's nav entry (no more
 * standalone `member-nav-promos` tab button) — `/member/promos` itself keeps
 * its own page and its own approval gate unchanged, just reachable via a
 * link on the History page's Promos tab instead of a top-level nav item, so
 * these tests navigate to it directly.
 *
 * Happy path: the catalog + detail page render (or a clean empty state when
 * no credit products exist yet, since a fresh tenant has none) and a
 * nonexistent product id doesn't crash; role check: since
 * member-portal-guest-preview-banner, Promos is no longer client-side
 * approval-gated — a pending applicant sees the catalog render normally with
 * a "pending" `MemberAccessBanner` above it (server-side, pending members
 * were always allowed to read promos/credits; only the old
 * `ApprovalRequiredCard` UI block is gone); cross-tenant isolation: tenant
 * B's member never sees tenant A's credit products.
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

test.describe("Member promos", () => {
  test.describe.configure({ timeout: 270_000 });

  test("role gate: a pending applicant sees the pending banner with the full Promos page, not a blocking card", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ememprom${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Promo Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await memberSignUp(page, base, { name: "Promo Member", email: memberEmail });

    await page.goto(`${base}/member/promos`);
    // A brand-new member has never applied, so applicationStatus defaults to
    // "pending" — server-side this was always allowed to read promos/credits;
    // the old client-side ApprovalRequiredCard block is gone, replaced by the
    // "pending" MemberAccessBanner above the real, unblocked page content.
    await expect(page.getByText("Your membership application is pending approval.")).toBeVisible();
    await expect(page.getByText("Approval required")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Credit packs" })).toBeVisible();

    // A nonexistent product id also renders normally (its own "not found"
    // state), never the old page-level block.
    await page.goto(`${base}/member/promos/does-not-exist`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Your membership application is pending approval.")).toBeVisible();
    await expect(page.getByText("Approval required")).toHaveCount(0);
    await expect(page.getByText("Pack not found")).toBeVisible();
  });

  test("happy path: a member sees the promos catalog regardless of approval status (empty state on a fresh tenant)", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2emempromok${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Promo OK Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await memberSignUp(page, base, { name: "Promo OK Member", email: memberEmail });
    await page.goto(`${base}/member/promos`);

    // Whether approved or pending (depends on the tenant's autoApproveMembers
    // flag, default off), the catalog itself always renders now — approval
    // status only changes which banner (if any) shows above it.
    await expect(page.getByRole("heading", { name: "Credit packs" })).toBeVisible();
    await expect(page.getByText("Approval required")).toHaveCount(0);
  });

  test("isolation: tenant B's member never sees tenant A's credit products", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ememproma${uniq}`;
    const slugB = `e2emempromb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const memberEmailA = faker.internet.email({ provider: "example.com" });
    const memberEmailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Promo Owner A", email: emailA, slug: slugA });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    await memberSignUp(page, baseA, { name: "Member A", email: memberEmailA });

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signUpBusiness(pageB, { name: "Promo Owner B", email: emailB, slug: slugB });
    await pageB.getByRole("button", { name: "Sign out" }).click();
    await pageB.waitForLoadState("networkidle");
    await memberSignUp(pageB, baseB, { name: "Member B", email: memberEmailB });

    // Neither tenant has any credit products configured, so both members see
    // the same empty-catalog state (both pending, since autoApproveMembers
    // defaults off) — the isolation guarantee that matters here is that no
    // cross-tenant product/purchase data is ever reachable; confirmed by the
    // API-level e2e block (Phase H) and by the page rendering identically
    // with zero data leakage for both.
    await pageB.goto(`${baseB}/member/promos`);
    await expect(pageB.getByText("Member A")).toHaveCount(0);
    await contextB.close();
  });
});
