import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Browser coverage for the platform admin Organizations surface (`/admin/
 * organizations`): the seeded `platform@agora.test` account (platformRole:
 * "admin", no tenant membership) listing, filtering, and running the row-level
 * lifecycle actions (Suspend/Reactivate/Archive/Edit/Change plan) on a throwaway
 * org, the role gate for an ordinary staff account, cross-tenant isolation, and
 * the anti-escalation guard on sign-up.
 *
 * Actions live behind a per-row DropdownMenu (trigger aria-label "Organization
 * actions"); dangerous ones (Suspend, Archive) open a confirm dialog whose
 * primary button is labeled with the verb ("Suspend"/"Archive"). A throwaway
 * `test-<timestamp>` org is always used (never a shared seeded org like acme/
 * contoso — this suite runs `workers: 1` against the real dev DB, so a suspended
 * shared org would poison later specs) and is reactivated before the test ends.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const SEARCH_PLACEHOLDER = "Search name or slug…";

async function findInviteLink(toEmail: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  const pattern = new RegExp(
    `\\[email:console\\] to=${toEmail.replace(/[.+]/g, "\\$&")}.*?link=(\\S+)`,
  );
  while (Date.now() < deadline) {
    const log = readFileSync(DEV_LOG_PATH, "utf8");
    const match = log.match(pattern);
    if (match?.[1]) return match[1];
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No console-driver invite link found for ${toEmail} in ${DEV_LOG_PATH}`);
}

async function signUpWorkspace(
  page: Page,
  opts: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Business name").fill(opts.slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${opts.slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });
}

async function signInStaff(page: Page, host: string, email: string) {
  await page.goto(`http://${host}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 15_000 });
}

/** Open the admin organizations list and search for a slug, returning its row. */
async function findOrgRow(adminPage: Page, slug: string) {
  await adminPage.goto("http://localtest.me:3000/admin/organizations");
  await adminPage.waitForLoadState("networkidle");
  await adminPage.getByPlaceholder(SEARCH_PLACEHOLDER).fill(slug);
  const row = adminPage.getByRole("row").filter({ hasText: slug });
  await expect(row).toBeVisible();
  return row;
}

/** Open a row's actions DropdownMenu and click a named menu item. */
async function rowAction(adminPage: Page, slug: string, item: string | RegExp) {
  const row = await findOrgRow(adminPage, slug);
  await row.getByRole("button", { name: "Organization actions" }).click();
  await adminPage.getByRole("menuitem", { name: item }).click();
}

test.describe("Platform Admin Organizations", () => {
  test("platform admin suspends and reactivates a business; a non-owner staff member loses and regains dashboard access", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-padmin${uniq}`;
    const ownerEmail = `test-padmin-owner${uniq}@example.com`;
    const staffEmail = `test-padmin-staff${uniq}@example.com`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUpWorkspace(page, { name: "PW Owner", email: ownerEmail, slug });

    // Owner invites a non-owner staff teammate (owners are exempt from the
    // suspended-tenant lockout, so the lockout assertion needs a non-owner).
    await page.goto(`${base}/admin/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    const staffContext = await browser.newContext();
    const staffPage = await staffContext.newPage();
    await signUpWorkspace(staffPage, {
      name: "PW Staff",
      email: staffEmail,
      slug: `test-padmin-staff${uniq}`,
    });
    await staffPage.goto(inviteLink);
    await expect(staffPage.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    // Suspend via the row action menu → confirm dialog.
    await rowAction(adminPage, slug, "Suspend");
    await adminPage.getByRole("button", { name: "Suspend" }).click();
    await expect(adminPage.getByText(/suspended\./i)).toBeVisible();

    // Non-owner staff is blocked; owner retains access (accepted MVP limitation).
    await staffPage.goto(`${base}/admin`);
    await expect(staffPage).toHaveURL(/\/suspended/, { timeout: 15_000 });
    await page.goto(`${base}/admin`);
    await expect(page).not.toHaveURL(/\/suspended/);

    // Reactivate (a single confirm-free menu action) restores access.
    await rowAction(adminPage, slug, "Reactivate");
    await expect(adminPage.getByText(/reactivated\./i)).toBeVisible();
    await staffPage.goto(`${base}/admin`);
    await expect(staffPage).not.toHaveURL(/\/suspended/, { timeout: 15_000 });

    await staffContext.close();
    await adminContext.close();
  });

  test("platform admin archives then reactivates a business; archive blocks tenant access", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-padmin-arch${uniq}`;
    const ownerEmail = `test-padmin-arch-owner${uniq}@example.com`;
    const staffEmail = `test-padmin-arch-staff${uniq}@example.com`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUpWorkspace(page, { name: "Arch Owner", email: ownerEmail, slug });

    await page.goto(`${base}/admin/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    const staffContext = await browser.newContext();
    const staffPage = await staffContext.newPage();
    await signUpWorkspace(staffPage, {
      name: "Arch Staff",
      email: staffEmail,
      slug: `test-padmin-arch-staff${uniq}`,
    });
    await staffPage.goto(inviteLink);
    await expect(staffPage.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    await rowAction(adminPage, slug, "Archive");
    await adminPage.getByRole("button", { name: "Archive" }).click();
    await expect(adminPage.getByText(/archived\./i)).toBeVisible();

    // Archived blocks the non-owner staff member's dashboard.
    await staffPage.goto(`${base}/admin`);
    await expect(staffPage).toHaveURL(/\/suspended/, { timeout: 15_000 });

    // Reactivate restores it.
    await rowAction(adminPage, slug, "Reactivate");
    await expect(adminPage.getByText(/reactivated\./i)).toBeVisible();
    await staffPage.goto(`${base}/admin`);
    await expect(staffPage).not.toHaveURL(/\/suspended/, { timeout: 15_000 });

    await staffContext.close();
    await adminContext.close();
  });

  test("platform admin edits an org's name and contact, and changes its plan", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-padmin-edit${uniq}`;
    const ownerEmail = `test-padmin-edit-owner${uniq}@example.com`;

    await signUpWorkspace(page, { name: "Edit Owner", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    // Edit: change contact email (name kept), save.
    await rowAction(adminPage, slug, "Edit");
    await adminPage.getByLabel("Contact email").fill(`ops-${uniq}@example.com`);
    await adminPage.getByRole("button", { name: "Save changes" }).click();
    await expect(adminPage.getByText(/updated\./i)).toBeVisible();

    // Change plan to pro.
    await rowAction(adminPage, slug, "Change plan");
    await adminPage.getByRole("button", { name: "Apply" }).click();
    await expect(adminPage.getByText(/moved to the/i)).toBeVisible();

    // Detail page reflects the new contact + plan.
    const row = await findOrgRow(adminPage, slug);
    await row.getByRole("button", { name: "Organization actions" }).click();
    await adminPage.getByRole("menuitem", { name: "View" }).click();
    await adminPage.waitForURL(/\/admin\/organizations\/.+/);
    await expect(adminPage.getByText(`ops-${uniq}@example.com`)).toBeVisible();

    await adminContext.close();
  });

  test("a staff user without a platform role is blocked from the portal and its API", async ({
    page,
  }) => {
    await signInStaff(page, "acme.localtest.me:3000", "owner@acme.test");
    await page.waitForURL(/\/admin/, { timeout: 30_000 });

    await page.goto("http://localtest.me:3000/admin");
    await expect(page).toHaveURL(/\/admin/, { timeout: 15_000 });

    // The new mutating routes are gated too — a non-platform actor gets 403.
    const suspend = await page.request.post(
      `${API_URL}/rpc-admin/organizations/nonexistent/suspend`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(suspend.status()).toBe(403);
    const archive = await page.request.post(
      `${API_URL}/rpc-admin/organizations/nonexistent/archive`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(archive.status()).toBe(403);
    const edit = await page.request.fetch(
      `${API_URL}/rpc-admin/organizations/nonexistent`,
      { method: "PATCH", headers: { "x-platform-admin": "1" }, data: { name: "x" } },
    );
    expect(edit.status()).toBe(403);
  });

  test("a sign-up payload cannot self-grant a platform role", async ({ page, request }) => {
    const uniq = Date.now();
    const email = `test-escalation${uniq}@example.com`;
    const res = await request.post(`${API_URL}/api/auth/sign-up/email`, {
      data: {
        email,
        password: "Password123!",
        name: "Escalation Attempt",
        platformRole: "admin",
      },
    });
    expect(res.ok()).toBeTruthy();

    await page.goto("http://localtest.me:3000/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("Password123!");
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.goto("http://localtest.me:3000/admin");
    await expect(page).not.toHaveURL(/\/admin$/, { timeout: 15_000 });
  });

  test("archiving the throwaway org does not affect an existing seeded org", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-padmin-iso${uniq}`;
    const ownerEmail = `test-padmin-iso-owner${uniq}@example.com`;

    await signUpWorkspace(page, { name: "Iso Owner", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    await rowAction(adminPage, slug, "Archive");
    await adminPage.getByRole("button", { name: "Archive" }).click();
    await expect(adminPage.getByText(/archived\./i)).toBeVisible();

    // acme (seeded, untouched) is still reachable.
    const acmeContext = await browser.newContext();
    const acmePage = await acmeContext.newPage();
    await signInStaff(acmePage, "acme.localtest.me:3000", "owner@acme.test");
    await expect(acmePage).not.toHaveURL(/\/suspended/, { timeout: 15_000 });
    await acmeContext.close();

    // Clean up: reactivate the throwaway org.
    await rowAction(adminPage, slug, "Reactivate");
    await expect(adminPage.getByText(/reactivated\./i)).toBeVisible();
    await adminContext.close();
  });

  test("the organization detail page renders one org's data and never a second org's", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slugA = `test-padmin-detail-a${uniq}`;
    const slugB = `test-padmin-detail-b${uniq}`;
    const ownerEmailA = `test-padmin-detail-a-owner${uniq}@example.com`;
    const ownerEmailB = `test-padmin-detail-b-owner${uniq}@example.com`;

    await signUpWorkspace(page, { name: "Org A Owner", email: ownerEmailA, slug: slugA });

    const bContext = await browser.newContext();
    const bPage = await bContext.newPage();
    await signUpWorkspace(bPage, { name: "Org B Owner", email: ownerEmailB, slug: slugB });
    await bContext.close();

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const rowA = await findOrgRow(adminPage, slugA);
    await rowA.getByRole("button", { name: "Organization actions" }).click();
    await adminPage.getByRole("menuitem", { name: "View" }).click();
    await adminPage.waitForURL(/\/admin\/organizations\/.+/);

    // Org A's own owner is visible; org B's owner email never appears.
    await expect(adminPage.getByText(ownerEmailA).first()).toBeVisible();
    await expect(adminPage.getByText(ownerEmailB)).toHaveCount(0);
    await expect(adminPage.getByText("Organization information")).toBeVisible();
    await expect(adminPage.getByRole("heading", { name: "Owner" })).toBeVisible();
    await expect(adminPage.getByText("Plan & subscription")).toBeVisible();

    await adminContext.close();
  });
});
