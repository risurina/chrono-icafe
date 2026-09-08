import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * member-portal-guest-preview-banner — the banner-instead-of-blocking-screen
 * gate (`MemberGate`/`Chrome` in `member-gate.tsx`, `MemberAccessBanner`,
 * `RequiresMembership`). Covers both states end to end:
 *
 * - A signed-in global customer who hasn't applied to this tenant ("guest
 *   mode") sees the normal Chrome (header + nav) with NO top banner at all —
 *   the old "not-applied" banner was removed entirely — and locked
 *   `RequiresMembership` sections carrying the Apply CTA instead of live
 *   data. Applying unlocks the real page in place.
 * - A `tenantMember` with `applicationStatus: "pending"` sees the "pending"
 *   banner with real, unblocked promo/credit-product data — the concrete
 *   server/client mismatch phase 1 fixed (server-side, pending members were
 *   always allowed to read promos/credits; only the old client-side
 *   `ApprovalRequiredCard` block is gone).
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

async function signOutOwner(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForLoadState("networkidle");
}

async function signUpGlobalCustomer(
  page: Page,
  { name, email }: { name: string; email: string },
) {
  await page.goto("/portal/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  // The global sign-up form lands on /member directly (member-player-route-rename).
  await page.waitForURL(/\/member$/, { timeout: 30_000 });
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

test.describe("Member portal — guest preview banner", () => {
  test.describe.configure({ timeout: 270_000 });

  test("guest mode: not-yet-applied global customer sees the not-applied banner and locked page, then unlocks by applying", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2emguestban${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Guest Banner Owner", email: ownerEmail, slug });
    await signOutOwner(page);

    await signUpGlobalCustomer(page, { name: "Guest Banner Customer", email: customerEmail });

    // Visiting the tenant's member dashboard as a not-yet-applied global
    // customer renders the normal Chrome (header + nav) — not a full-page
    // takeover, and no top banner either (that banner was removed entirely) —
    // with a locked `RequiresMembership` section instead of live data.
    await page.goto(`${base}/member`);
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByText("Join this business — apply to become a customer to unlock your account."),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Join this business to see your live account data here." }),
    ).toBeVisible();
    await expect(
      page.getByText("Apply to become a customer of this business to unlock this section."),
    ).toBeVisible();
    // The nav is present — this proves Chrome rendered, not a takeover card.
    // (Both the desktop tab bar and mobile bottom nav carry a "session" item —
    // scope to the desktop tab's stable test id to avoid a strict-mode
    // ambiguity between the two.)
    await expect(page.getByTestId("member-nav-session")).toBeVisible();
    // No pending banner should show for a guest with no tenantMember row yet.
    await expect(page.getByText("Your membership application is pending approval.")).toHaveCount(
      0,
    );

    // Applying (from the locked card's own button, not a top banner) performs
    // the existing apply sequence and reloads into the unlocked portal — the
    // locked card is gone (replaced by the pending banner, since
    // autoApproveMembers defaults off) and real data (the dashboard's
    // playtime card) now renders in place of it.
    await page.getByRole("button", { name: "Apply" }).click();
    await expect(page.getByRole("heading", { name: /^Welcome/ })).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Join this business to see your live account data here." }),
    ).toHaveCount(0);
    await expect(page.getByText("Your membership application is pending approval.")).toBeVisible();
    await expect(page.getByTestId("playtime-hero")).toBeVisible();
  });

  test("pending member: sees the pending banner with real promo/credit data, not a locked or blocking state", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2emguestpend${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Pending Banner Owner", email: ownerEmail, slug });
    await signOutOwner(page);

    await memberSignUp(page, base, { name: "Pending Banner Member", email: memberEmail });

    // A brand-new tenant-only member has never applied, so applicationStatus
    // defaults to "pending" (autoApproveMembers is off by default) — real
    // promos/credit-product data still renders underneath the pending
    // banner, since server-side this was never gated on approval status.
    await page.goto(`${base}/member/promos`);
    await expect(page.getByText("Your membership application is pending approval.")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Join this business to see your live account data here." }),
    ).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Credit packs" })).toBeVisible();
  });
});
