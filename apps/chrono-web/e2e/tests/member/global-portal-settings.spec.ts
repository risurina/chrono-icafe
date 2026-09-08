import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Apex global-customer settings page (`/member/settings`, `agora/customer-auth`)
 * — replaces the old `/member/profile` "Your account" read-only card
 * (chrono/member-profile-page-lounge-tabs, Phase 3) with an editable settings
 * page mirroring the tenant member area's own `/member/settings`
 * (`profile-settings.spec.ts` / `profile-security-and-avatar.spec.ts`) —
 * different surface, different auth pool, unrelated coverage.
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

test.describe("Global portal settings page (apex /member/settings)", () => {
  test("sidebar Settings link navigates to /member/settings and renders the signed-in customer's name and email", async ({
    page,
  }) => {
    const name = faker.person.fullName();
    const email = faker.internet.email({ provider: "example.com" });

    await signUpGlobalCustomer(page, { name, email });

    // ── /member no longer shows any account/identity details — only the
    // welcome heading and the tabbed directory (this plan's Phase 1/2). ──
    await expect(page.getByRole("heading", { level: 1 }).filter({ hasText: name })).toBeVisible();
    await expect(page.getByText("Edit Profile Details")).toHaveCount(0);

    // ── Navigate via the sidebar's "Settings" link, not a direct goto, so
    // this also proves the nav item itself works end-to-end. ──
    await page.getByRole("link", { name: "Settings" }).click();
    await page.waitForURL(/\/member\/settings$/, { timeout: 15_000 });

    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Edit Profile Details" })).toBeVisible();
    await expect(page.getByLabel("Full Name")).toHaveValue(name);
    // `agora/customer-auth` stores the email lowercased (case-insensitive
    // uniqueness) — assert against the normalized form the page actually
    // renders, not the faker-generated (possibly mixed-case) input.
    await expect(page.getByLabel("Email Address")).toHaveValue(email.toLowerCase());
  });

  test("editing the name and saving persists via customerAuth.updateProfile", async ({ page }) => {
    const name = faker.person.fullName();
    const email = faker.internet.email({ provider: "example.com" });
    const newName = faker.person.fullName();

    await signUpGlobalCustomer(page, { name, email });
    await page.goto("/member/settings");
    await page.waitForLoadState("networkidle");

    await page.getByLabel("Full Name").fill(newName);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Profile updated.")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Full Name")).toHaveValue(newName);
  });
});
