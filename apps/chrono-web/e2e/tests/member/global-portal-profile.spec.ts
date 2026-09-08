import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Apex "Your account" identity page (`/member/profile`, a signed-in global
 * customer, `agora/customer-auth`) — chrono/member-profile-page-lounge-tabs,
 * Phase 3. This is the apex-only global-portal profile page moved out of
 * `/member` (`global-portal-home.tsx`) into its own route
 * (`global-portal-profile.tsx`); it is NOT the tenant-side `/player/profile`
 * page covered by `profile-settings.spec.ts` / `profile-security-and-avatar.spec.ts`
 * — different surface, different auth pool, unrelated coverage.
 *
 * Reuses the same global-customer sign-up flow as
 * `lounge-directory.spec.ts` (same apex `/member/sign-up` surface).
 */
const PASSWORD = "Password123!";

async function signUpGlobalCustomer(
  page: Page,
  { name, email }: { name: string; email: string },
) {
  await page.goto("/member/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(/\/member$/, { timeout: 30_000 });
}

test.describe("Global portal profile page (apex /member/profile)", () => {
  test("sidebar Profile link navigates to /member/profile and renders the signed-in customer's name and email", async ({
    page,
  }) => {
    const name = faker.person.fullName();
    const email = faker.internet.email({ provider: "example.com" });

    await signUpGlobalCustomer(page, { name, email });

    // ── /member no longer shows any account/identity details — only the
    // welcome heading and the tabbed directory (this plan's Phase 1/2). ──
    await expect(page.getByRole("heading", { level: 1 }).filter({ hasText: name })).toBeVisible();
    await expect(page.getByText("Your account")).toHaveCount(0);

    // ── Navigate via the sidebar's "Profile" link, not a direct goto, so
    // this also proves the nav item itself works end-to-end. ──
    await page.getByRole("link", { name: "Profile" }).click();
    await page.waitForURL(/\/member\/profile$/, { timeout: 15_000 });

    await expect(page.getByRole("heading", { name: "Profile" })).toBeVisible();
    await expect(page.getByText("Your account")).toBeVisible();
    // The sidebar's identity block (`global-portal-sidebar.tsx`) also renders
    // the signed-in customer's name/email on every `/member/*` page, so a
    // bare `page.getByText(...)` is ambiguous here (strict-mode violation:
    // matches both the sidebar span and the profile card's <dd>). Scope to
    // the profile card's `<dl>` (`global-portal-profile.tsx`), which is the
    // only definition list on this page.
    const accountDetails = page.locator("dl");
    await expect(accountDetails.getByText(name, { exact: true })).toBeVisible();
    // `agora/customer-auth` stores the email lowercased (case-insensitive
    // uniqueness) — assert against the normalized form the page actually
    // renders, not the faker-generated (possibly mixed-case) input.
    await expect(accountDetails.getByText(email.toLowerCase(), { exact: true })).toBeVisible();
  });
});
