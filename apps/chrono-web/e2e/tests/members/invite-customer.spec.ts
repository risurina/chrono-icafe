import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * .ai/plans/chrono/active/customer-invite/README.md — Phase 4. Covers the
 * "Invite" action on /admin/members: happy path (staff invites → row
 * appears approved → invitee accepts the emailed link → signs in on
 * /portal), the admin+-only role gate, and cross-tenant isolation of the
 * accept-invite token. Mirrors members/members.spec.ts's own
 * console-email-driver link recovery.
 */

const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";

async function findInviteLink(toEmail: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  // The server always lowercases the recipient before logging, so match
  // case-insensitively rather than assuming toEmail's own casing survives.
  const pattern = new RegExp(
    `\\[email:console\\] to=${toEmail.replace(/[.+]/g, "\\$&")}.*?link=(\\S+)`,
    "i",
  );
  while (Date.now() < deadline) {
    const log = readFileSync(DEV_LOG_PATH, "utf8");
    const match = log.match(pattern);
    if (match?.[1]) return match[1];
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No console-driver invite link found for ${toEmail} in ${DEV_LOG_PATH}`);
}

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
  // "Business name" auto-derives "Business URL" via the page's own slugify() —
  // filling it with the already-lowercased slug leaves the URL unchanged.
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });
}

async function inviteCustomer(
  page: import("@playwright/test").Page,
  base: string,
  { name, email }: { name: string; email: string },
) {
  await page.goto(`${base}/admin/members`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Invite player" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send invite" }).click();
}

test.describe("Invite a customer", () => {
  test("happy path: owner invites, invitee accepts, signs in on the portal", async ({
    page,
    browser,
  }) => {
    // Business name/URL is auto-lowercased by the sign-up page's own slugify(),
    // so the typed value must already be lowercase or the two would diverge.
    const uniq = faker.string.alphanumeric(8).toLowerCase().toLowerCase();
    const slug = `e2einva${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const inviteeEmail = faker.internet.email({ provider: "example.com" });
    const inviteeName = faker.person.fullName();
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Tenant Owner", email: ownerEmail, slug });

    await inviteCustomer(page, base, { name: inviteeName, email: inviteeEmail });
    await expect(page.getByText("Invite sent.")).toBeVisible();

    // Row appears immediately, already approved — no separate approve step.
    // The server lowercases the stored email, so match case-insensitively.
    const row = page.getByRole("row", { name: new RegExp(inviteeEmail, "i") });
    await expect(row.getByText("approved", { exact: true })).toBeVisible();

    const inviteLink = await findInviteLink(inviteeEmail);

    const inviteeCtx = await browser.newContext();
    const inviteePage = await inviteeCtx.newPage();
    await inviteePage.goto(inviteLink);
    await inviteePage.getByLabel("Password").fill("Password123!");
    await inviteePage.getByRole("button", { name: "Activate account" }).click();

    // accept-invite signs the customer straight in and lands them on /portal.
    await inviteePage.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/portal$`), {
      timeout: 15_000,
    });

    // A fresh sign-in with the chosen password also works.
    await inviteePage.goto(`${base}/login`);
    await inviteePage.getByLabel("Email").fill(inviteeEmail);
    await inviteePage.getByLabel("Password").fill("Password123!");
    await inviteePage.getByRole("button", { name: "Sign in" }).click();
    await inviteePage.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/portal$`), {
      timeout: 15_000,
    });

    await inviteeCtx.close();
  });

  test("role gate: staff cannot see or use the Invite action", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase().toLowerCase();
    const slug = `e2einvb${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2einvbstaff${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // Owner invites a staff teammate (Better Auth staff invite, unrelated flow).
    await page.goto(`${base}/admin/settings/crew`);
    await page.waitForLoadState("networkidle");
    const inviteInput = page.getByPlaceholder("teammate@example.com");
    await inviteInput.fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const staffInviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    await signUp(page, { name: "PW Staff", email: staffEmail, slug: staffSlug });
    await page.goto(staffInviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
      timeout: 15_000,
    });

    // Staff (memberProfile:invite not granted) sees no Invite control.
    await page.goto(`${base}/admin/members`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Invite player" })).toHaveCount(0);
  });

  test("cross-tenant isolation: an invite token minted for tenant A cannot be accepted on tenant B", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase().toLowerCase();
    const slugA = `e2einvca${uniq}`;
    const slugB = `e2einvcb${uniq}`;
    const ownerAEmail = faker.internet.email({ provider: "example.com" });
    const ownerBEmail = faker.internet.email({ provider: "example.com" });
    const inviteeEmail = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;

    await signUp(page, { name: "Tenant A Owner", email: ownerAEmail, slug: slugA });
    await inviteCustomer(page, baseA, { name: "Isolation Target", email: inviteeEmail });
    await expect(page.getByText("Invite sent.")).toBeVisible();
    const inviteLink = await findInviteLink(inviteeEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    await signUp(page, { name: "Tenant B Owner", email: ownerBEmail, slug: slugB });

    // Rewrite the accept-invite link's host from tenant A to tenant B — the
    // token is tenant-scoped (RLS via withTenant), so it must not resolve.
    const crossTenantLink = inviteLink.replace(
      `${slugA}.localtest.me`,
      `${slugB}.localtest.me`,
    );

    const inviteeCtx = await browser.newContext();
    const inviteePage = await inviteeCtx.newPage();
    await inviteePage.goto(crossTenantLink);
    await inviteePage.getByLabel("Password").fill("Password123!");
    await inviteePage.getByRole("button", { name: "Activate account" }).click();
    // sonner renders the error toast twice in the DOM (visual + a11y-live-region
    // duplicate), so scope to the first match rather than hitting strict mode.
    await expect(inviteePage.getByText(/invalid or has expired/i).first()).toBeVisible();
    await inviteeCtx.close();

    // The original, correct-host link still works.
    const correctCtx = await browser.newContext();
    const correctPage = await correctCtx.newPage();
    await correctPage.goto(inviteLink);
    await correctPage.getByLabel("Password").fill("Password123!");
    await correctPage.getByRole("button", { name: "Activate account" }).click();
    await correctPage.waitForURL(new RegExp(`//${slugA}\\.localtest\\.me:3000/portal$`), {
      timeout: 15_000,
    });
    await correctCtx.close();
  });
});
