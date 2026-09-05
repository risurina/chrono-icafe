import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";
import { waitForMailtrapInviteLink } from "../../utils/mailtrap-inbox";

/**
 * Browser coverage for the member-invite UI on the settings page: creating an
 * invite, seeing it listed, resending/revoking it, and — reading the accept link
 * back out of a Mailtrap sandbox inbox after a real send through
 * `EMAIL_PROVIDER=mailtrap` — the full accept flow through a real second browser
 * session. The admin-only role gate, cross-tenant rejection, and replay
 * rejection remain covered by the API-level suite (`pnpm test:e2e` →
 * `apps/api/src/e2e/run.ts`).
 *
 * The third test below requires the chrono-api dev server to be running with
 * `EMAIL_PROVIDER=mailtrap` + `MAILTRAP_API_TOKEN` + `MAILTRAP_TEST_INBOX_ID` set.
 */

test.describe("Members invite", () => {
  test("owner sends an invite and sees it listed", async ({ page }) => {
    const uniq = Date.now();
    const slug = `e2emem${uniq}`;
    const email = `pwmem${uniq}@example.com`;
    const inviteeEmail = `ronnie.isurina+${uniq}@gmail.com`;
    const base = `http://${slug}.localtest.me:3000`;

    await page.goto("/sign-up");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await page.getByLabel("Your name").fill("PW Members");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByLabel("Business name").fill(slug);
    await page.getByRole("button", { name: /create business/i }).click();
    await page.waitForURL(
      new RegExp(`//${slug}\\.localtest\\.me:3000/admin`),
      { timeout: 60_000 },
    );

    await page.goto(`${base}/admin/settings/crew`);
    await page.waitForLoadState("networkidle");

    const inviteInput = page.getByPlaceholder("teammate@example.com");
    await inviteInput.fill(inviteeEmail);
    await page.keyboard.press("Escape");
    await expect(inviteInput).toHaveValue(inviteeEmail);
    await page.getByRole("button", { name: "Invite crew" }).click();

    await expect(page.getByText(/invitation (sent|created)/i)).toBeVisible();
    await expect(page.getByText(inviteeEmail)).toBeVisible();
  });

  test("owner resends and revokes a pending invite", async ({ page }) => {
    const uniq = Date.now();
    const slug = `e2eminv${uniq}`;
    const email = `pwminv${uniq}@example.com`;
    const inviteeEmail = `ronnie.isurina+${uniq}@gmail.com`;
    const base = `http://${slug}.localtest.me:3000`;

    await page.goto("/sign-up");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await page.getByLabel("Your name").fill("PW Members");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByLabel("Business name").fill(slug);
    await page.getByRole("button", { name: /create business/i }).click();
    await page.waitForURL(
      new RegExp(`//${slug}\\.localtest\\.me:3000/admin`),
      { timeout: 60_000 },
    );

    await page.goto(`${base}/admin/settings/crew`);
    await page.waitForLoadState("networkidle");

    const inviteInput = page.getByPlaceholder("teammate@example.com");
    await inviteInput.fill(inviteeEmail);
    await page.keyboard.press("Escape");
    await expect(inviteInput).toHaveValue(inviteeEmail);
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(inviteeEmail)).toBeVisible();

    const inviteRow = page
      .locator("li")
      .filter({ hasText: inviteeEmail });

    await inviteRow.getByRole("button", { name: "Resend" }).click();
    await expect(page.getByText("Invitation resent.")).toBeVisible();

    await inviteRow.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Invitation revoked.")).toBeVisible();
    await expect(page.getByText(inviteeEmail)).toHaveCount(0);
    await expect(page.getByText("No pending invitations.")).toBeVisible();
  });

  test("invitee accepts the invite via the emailed link and appears as a member", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slug = `e2emacc${uniq}`;
    const ownerEmail = `pwmacc${uniq}@example.com`;
    const inviteeEmail = faker.internet.email({ provider: "example.com" });
    const inviteeSlug = `e2emaccinv${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    // Owner signs up and creates the tenant.
    await page.goto("/sign-up");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await page.getByLabel("Your name").fill("PW Members");
    await page.getByLabel("Email").fill(ownerEmail);
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByLabel("Business name").fill(slug);
    await page.getByRole("button", { name: /create business/i }).click();
    await page.waitForURL(
      new RegExp(`//${slug}\\.localtest\\.me:3000/admin`),
      { timeout: 60_000 },
    );

    // Owner invites the teammate.
    await page.goto(`${base}/admin/settings/crew`);
    await page.waitForLoadState("networkidle");
    const inviteInput = page.getByPlaceholder("teammate@example.com");
    await inviteInput.fill(inviteeEmail);
    await page.keyboard.press("Escape");
    await expect(inviteInput).toHaveValue(inviteeEmail);
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(inviteeEmail)).toBeVisible();

    // Recover the accept link from the real email sent via Mailtrap.
    const inviteLink = await waitForMailtrapInviteLink(inviteeEmail);

    // Sign the invitee out and create their own account (their own business),
    // matching how a real invitee would arrive with an existing session.
    await page.goto(`${base}/admin/settings/crew`);
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await page.goto("/sign-up");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
    await page.getByLabel("Your name").fill("PW Invitee");
    await page.getByLabel("Email").fill(inviteeEmail);
    await page.getByLabel("Password", { exact: true }).fill("Password123!");
    await page.getByLabel("Business name").fill(inviteeSlug);
    await page.getByRole("button", { name: /create business/i }).click();
    await page.waitForURL(
      new RegExp(`//${inviteeSlug}\\.localtest\\.me:3000/admin`),
      { timeout: 60_000 },
    );

    // Follow the emailed accept link — cross-subdomain cookies keep the invitee
    // signed in on the invited tenant's host.
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
      timeout: 15_000,
    });

    // Owner sees the invitee as a member with the invited role.
    await page.goto(`${base}/admin/settings/crew`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("main").getByText(inviteeEmail)).toBeVisible();
    await expect(page.getByText("No pending invitations.")).toBeVisible();
  });
});
