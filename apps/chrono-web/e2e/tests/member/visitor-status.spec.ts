import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * member-visitor-status-tier — the "visitor" application-status tier
 * (`MemberGate`/`Chrome` in `member-gate.tsx`, `useMemberArea().canInteract`,
 * `UnlockHint`). Replaces `guest-preview-banner.spec.ts`
 * (member-portal-guest-preview-banner): "guest mode" and its top banner /
 * full-section lock are both gone. Covers the actual shipped behavior:
 *
 * - A signed-in global customer visiting a tenant's `/member/*` for the first
 *   time is silently registered as a `"visitor"` (a real `tenantMember` +
 *   `chronoMemberProfile` row) — no click, no dialog, no banner, and no
 *   full-page/section lock. Every read (dashboard, promos, wallet balance,
 *   reservations, history, …) renders immediately.
 * - A mutating control (e.g. Settings' "Save changes") stays disabled for a
 *   visitor, with an inline `UnlockHint` ("Apply to unlock") next to it —
 *   never a locked section.
 * - Clicking that affordance runs the existing apply sequence, which now
 *   promotes the visitor row to `"pending"`/`"approved"` (per the tenant's
 *   `chrono.autoApproveMembers` flag) instead of a no-op, and unlocks the
 *   control.
 * - A `"pending"`/`"approved"` member (the default for a tenant-only signup,
 *   which never goes through the visitor step) sees every control enabled,
 *   with no `UnlockHint` anywhere.
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

test.describe("Member portal — visitor status tier", () => {
  test.describe.configure({ timeout: 270_000 });

  test("first visit silently registers a visitor: no banner, no lock, real dashboard data renders immediately", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2emvisitor${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Visitor Owner", email: ownerEmail, slug });
    await signOutOwner(page);

    await signUpGlobalCustomer(page, { name: "Visitor Customer", email: customerEmail });

    // Visiting the tenant's member dashboard as a global customer with no
    // prior tenantMember silently registers them as a "visitor" (MemberGate's
    // applyForTenantMembership() + registerVisit() + reload) — the steady
    // state is real data, not a guest/locked render.
    await page.goto(`${base}/member`);
    await expect(page.getByRole("heading", { name: /^Welcome/ })).toBeVisible({ timeout: 15_000 });

    // No lock/gate copy of any kind, and no pending banner (a visitor is not
    // "pending" — the banner only shows for that status).
    await expect(
      page.getByText("Apply to become a customer of this business to unlock this section."),
    ).toHaveCount(0);
    await expect(page.getByText("Your membership application is pending approval.")).toHaveCount(
      0,
    );

    // Real read content renders unconditionally — the nav proves Chrome
    // rendered (not a takeover card), and the playtime card proves the
    // dashboard's own data fetch ran (skipped only when `member` is null).
    await expect(page.getByTestId("member-nav-session")).toBeVisible();
    await expect(page.getByTestId("playtime-hero")).toBeVisible();
  });

  test("a mutating control stays disabled with an inline Apply affordance for a visitor; applying promotes and unlocks it", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2emvisitunlk${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Visitor Unlock Owner", email: ownerEmail, slug });
    await signOutOwner(page);
    await signUpGlobalCustomer(page, { name: "Visitor Unlock Customer", email: customerEmail });

    await page.goto(`${base}/member/settings`);
    await page.waitForLoadState("networkidle");

    // A visitor's profile-save control is visibly present but disabled, with
    // an adjacent UnlockHint (the settings page renders two — profile save
    // and change-password — so scope to the first).
    const saveButton = page.getByRole("button", { name: "Save changes" });
    await expect(saveButton).toBeDisabled({ timeout: 15_000 });
    await expect(page.getByText("Visiting — apply to unlock this.").first()).toBeVisible();

    // Clicking the affordance runs the apply sequence, which now promotes
    // the visitor row to "pending"/"approved" (autoApproveMembers off by
    // default here) instead of a no-op, and reloads into the unlocked page.
    await page.getByRole("button", { name: "Apply to unlock" }).first().click();
    await expect(saveButton).toBeEnabled({ timeout: 15_000 });
    await expect(page.getByText("Visiting — apply to unlock this.")).toHaveCount(0);
  });

  test("a pending/approved member sees every control enabled, with no visitor UnlockHint anywhere", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2emvisitok${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Visitor OK Owner", email: ownerEmail, slug });
    await signOutOwner(page);

    // A tenant-only signup never goes through the visitor step — a
    // brand-new tenantMember with no chronoMemberProfile row reads as
    // "pending" by default (server-side, unrelated to this plan).
    await memberSignUp(page, base, { name: "Visitor OK Member", email: memberEmail });

    await page.goto(`${base}/member/settings`);
    await expect(page.getByRole("button", { name: "Save changes" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Change password" })).toBeEnabled();
    await expect(page.getByText("Visiting — apply to unlock this.")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Apply to unlock" })).toHaveCount(0);
  });
});
