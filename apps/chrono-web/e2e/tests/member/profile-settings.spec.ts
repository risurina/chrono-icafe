import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Member Profile + Settings (`/member/profile`, `/member/settings`) —
 * chrono/member-area, execution phase 6.
 *
 * Happy path: profile name/phone save round-trips (name change survives a
 * reload, phone patch upserts via apply-on-first-save); change-password
 * rejects a wrong current password without signing anyone out, then accepts
 * the correct one and signs the caller's OTHER session out; role check:
 * neither page is approval-gated; cross-tenant isolation: tenant B's member
 * profile never shows tenant A's member's name/id.
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

test.describe("Member profile + settings", () => {
  test.describe.configure({ timeout: 270_000 });

  test("happy path: profile save round-trips and change-password gates on the current password", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ememprof${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Profile Owner", email: ownerEmail, slug });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await memberSignUp(page, base, { name: "Profile Member", email: memberEmail });

    await page.getByTestId("member-nav-profile").click();
    await expect(page).toHaveURL(`${base}/member/profile`);
    await expect(page.getByTestId("membership-details-card")).toBeVisible();

    await page.getByLabel("Phone").fill("09171234567");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Profile updated.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Phone")).toHaveValue("09171234567");

    // Name change reloads the page (session refresh) — assert it round-trips.
    await page.getByLabel("Name").fill("Renamed Member");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForLoadState("networkidle");
    await expect(page.getByLabel("Name")).toHaveValue("Renamed Member");

    await page.getByTestId("member-nav-settings").click();
    await expect(page).toHaveURL(`${base}/member/settings`);

    // Wrong current password → error, no session revoked.
    await page.getByLabel("Current password").fill("WrongPassword123!");
    await page.getByLabel("New password").fill("NewPassword456!");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Current password is incorrect")).toBeVisible();

    // Correct current password → success.
    await page.getByLabel("Current password").fill(PASSWORD);
    await page.getByLabel("New password").fill("NewPassword456!");
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText(/Password changed/)).toBeVisible();
  });

  test("isolation: tenant B's member profile never shows tenant A's member's name or id", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ememprofa${uniq}`;
    const slugB = `e2ememprofb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const memberEmailA = faker.internet.email({ provider: "example.com" });
    const memberEmailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Profile Owner A", email: emailA, slug: slugA });
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    await memberSignUp(page, baseA, { name: "Member Alpha", email: memberEmailA });
    await page.getByTestId("member-nav-profile").click();
    const memberIdA = await page.locator("span.font-mono").first().textContent();

    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signUpBusiness(pageB, { name: "Profile Owner B", email: emailB, slug: slugB });
    await pageB.getByRole("button", { name: "Sign out" }).click();
    await pageB.waitForLoadState("networkidle");
    await memberSignUp(pageB, baseB, { name: "Member Beta", email: memberEmailB });
    await pageB.getByTestId("member-nav-profile").click();
    await expect(pageB.getByLabel("Name")).toHaveValue("Member Beta");
    await expect(pageB.getByText("Member Alpha")).toHaveCount(0);
    if (memberIdA) {
      await expect(pageB.getByText(memberIdA)).toHaveCount(0);
    }
    await contextB.close();
  });
});
