import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * customer-onboarding Phase 4 — the journey from portal signup to a legible
 * pending/rejected/approved state, plus the staff pending-count badge and the
 * `chrono.autoApproveMembers` flag. Mirrors apps/chrono-web/e2e/tests/members/
 * members.spec.ts's own signup/invite helpers exactly.
 *
 * Not asserted here (deliberately out of scope for this pass, see
 * .ai/plans/chrono/active/customer-onboarding/README.md, Decision 3 and the
 * "Web UI" section): eager wallet provisioning on approval (provisioning is
 * lazy, on first use, unchanged by this plan) and a customer-initiated
 * "start a session" action (sessions are staff/kiosk-initiated only — the
 * approved state links to nothing, it only states the customer now qualifies
 * for member-rate pricing).
 */

async function signUp(
  page: import("@playwright/test").Page,
  { name, email, slug }: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Password123!");
  await page.getByLabel("Workspace name").fill(slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function portalSignUp(
  page: import("@playwright/test").Page,
  { name, email, base }: { name: string; email: string; base: string },
) {
  await page.goto(`${base}/portal/sign-up`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Password123!");
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(new RegExp(`//${new URL(base).hostname}:3000/portal$`), {
    timeout: 30_000,
  });
}

test.describe("Customer onboarding", () => {
  test("happy path: pending state, staff approves, portal reflects approved", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2eonba${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    // 1. Owner sets up the tenant.
    await signUp(page, { name: "Onboarding Owner", email: ownerEmail, slug });

    // 2. Customer signs up on the portal and applies.
    const customerCtx = await browser.newContext();
    const customerPage = await customerCtx.newPage();
    const customerEmail = faker.internet.email({ provider: "example.com" });
    await portalSignUp(customerPage, { name: "Onboarding Customer", email: customerEmail, base });

    await customerPage.getByRole("button", { name: "Apply for membership" }).click();
    await expect(customerPage.getByText("pending", { exact: true })).toBeVisible();
    // The wait must be legible, not just a status word (the whole point of this plan).
    await expect(
      customerPage.getByText(/staff member needs to review your application/i),
    ).toBeVisible();

    // 3. Staff sees the pending badge and approves from the dashboard.
    await page.goto(`${base}/dashboard/members`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("1 pending", { exact: true })).toBeVisible();
    const row = page.getByRole("row", { name: new RegExp(customerEmail) });
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Application approved.")).toBeVisible();

    // The badge clears once nothing is left waiting.
    await expect(page.getByText("1 pending", { exact: true })).toHaveCount(0);

    // 4. Customer reloads and sees the approved state.
    await customerPage.reload();
    await customerPage.waitForLoadState("networkidle");
    await expect(customerPage.getByText("approved", { exact: true })).toBeVisible();
    await expect(
      customerPage.getByText(/you now qualify for member-rate pricing/i),
    ).toBeVisible();

    await customerCtx.close();
  });

  test("role gate: staff cannot approve, and a staff session cannot reach the member portal", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2eonbb${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2eonbbinv${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    // 1. Owner signs up and invites a staff teammate.
    await signUp(page, { name: "Onboarding Owner", email: ownerEmail, slug });
    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const { readFileSync } = await import("node:fs");
    const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";
    const deadline = Date.now() + 15_000;
    const pattern = new RegExp(
      `\\[email:console\\] to=${staffEmail.replace(/[.+]/g, "\\$&")}.*?link=(\\S+)`,
    );
    let inviteLink = "";
    while (Date.now() < deadline) {
      const log = readFileSync(DEV_LOG_PATH, "utf8");
      const match = log.match(pattern);
      if (match?.[1]) {
        inviteLink = match[1];
        break;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(inviteLink).not.toBe("");

    // 2. A customer applies.
    const customerCtx = await browser.newContext();
    const customerPage = await customerCtx.newPage();
    const customerEmail = faker.internet.email({ provider: "example.com" });
    await portalSignUp(customerPage, { name: "Gate Customer", email: customerEmail, base });
    await customerPage.getByRole("button", { name: "Apply for membership" }).click();
    await expect(customerPage.getByText("pending", { exact: true })).toBeVisible();
    await customerCtx.close();

    // 3. Staff signs up via the invite link.
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    await signUp(page, { name: "Onboarding Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    // 4. Staff can see the applicant but cannot approve (memberProfile:approve
    // is admin+ only, staff holds memberProfile:read only).
    await page.goto(`${base}/dashboard/members`);
    await page.waitForLoadState("networkidle");
    const row = page.getByRole("row", { name: new RegExp(customerEmail) });
    await expect(row.getByText("pending", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(
      page.getByText("Only admins can approve or reject applications."),
    ).toBeVisible();
    await expect(row.getByText("pending", { exact: true })).toBeVisible();

    // 5. The staff's own (Better Auth) session holds no tenantMember/portal
    // session, so the member portal refuses it — memberMiddleware resolves no
    // member and the portal layout redirects to /portal/login rather than
    // showing any customer's onboarding state.
    await page.goto(`${base}/portal`);
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/portal/login$`), {
      timeout: 15_000,
    });
  });

  test("cross-tenant isolation: tenant A's pending applicant never reaches tenant B", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slugA = `e2eonbca${uniq}`;
    const slugB = `e2eonbcb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    // 1. Tenant A, with a pending applicant.
    await signUp(page, { name: "Tenant A Owner", email: emailA, slug: slugA });
    const customerCtx = await browser.newContext();
    const customerPage = await customerCtx.newPage();
    const customerEmail = faker.internet.email({ provider: "example.com" });
    await portalSignUp(customerPage, { name: "Isolation Customer", email: customerEmail, base: baseA });
    await customerPage.getByRole("button", { name: "Apply for membership" }).click();
    await expect(customerPage.getByText("pending", { exact: true })).toBeVisible();

    await page.goto(`${baseA}/dashboard/members`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("1 pending", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // 2. Tenant B — a fresh tenant with no applicants of its own.
    await signUp(page, { name: "Tenant B Owner", email: emailB, slug: slugB });
    await page.goto(`${baseB}/dashboard/members`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("No members yet.")).toBeVisible();
    await expect(page.getByText(customerEmail)).toHaveCount(0);
    // The pending badge must not leak tenant A's count into tenant B's view.
    await expect(page.getByText(/\d+ pending/)).toHaveCount(0);

    // 3. Tenant A's customer session cannot reach tenant B's portal either —
    // the session lookup is scoped by withTenant(org.id) inside
    // getMemberContext, so a cross-tenant cookie resolves to no member and
    // the portal layout redirects to login rather than showing any state.
    await customerPage.goto(`${baseB}/portal`);
    await customerPage.waitForURL(new RegExp(`//${slugB}\\.localtest\\.me:3000/portal/login$`), {
      timeout: 15_000,
    });

    await customerCtx.close();
  });

  test("flag on: chrono.autoApproveMembers grants instant access at signup", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2eonbd${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    // 1. Owner turns the flag on.
    await signUp(page, { name: "Flag Owner", email: ownerEmail, slug });
    await page.goto(`${base}/dashboard/settings/features`);
    await page.waitForLoadState("networkidle");
    const toggle = page.getByRole("switch", { name: "Toggle Auto-approve members" });
    await expect(toggle).not.toBeChecked();
    await toggle.click();
    await expect(page.getByText("Feature updated.")).toBeVisible();
    await expect(toggle).toBeChecked();

    // 2. A new applicant is approved instantly — no staff action needed.
    const customerCtx = await browser.newContext();
    const customerPage = await customerCtx.newPage();
    const customerEmail = faker.internet.email({ provider: "example.com" });
    await portalSignUp(customerPage, { name: "Instant Customer", email: customerEmail, base });
    await customerPage.getByRole("button", { name: "Apply for membership" }).click();
    await expect(customerPage.getByText("approved", { exact: true })).toBeVisible();
    await expect(customerPage.getByText("pending", { exact: true })).toHaveCount(0);

    // No pending badge should appear on staff's side for this applicant.
    await page.goto(`${base}/dashboard/members`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/\d+ pending/)).toHaveCount(0);
    const row = page.getByRole("row", { name: new RegExp(customerEmail) });
    await expect(row.getByText("approved", { exact: true })).toBeVisible();

    await customerCtx.close();
  });
});
