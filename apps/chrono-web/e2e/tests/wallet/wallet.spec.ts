import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the Wallet module (chrono/wallet).
 *
 * Per Phase 5 of .ai/plans/chrono/active/wallet/README.md:
 * - Happy path: sign up a tenant (staff) + a customer via /portal/sign-up; as staff,
 *   navigate to /dashboard/wallets, top up the customer's wallet, confirm balance
 *   updates and history shows credit; debit amount less than balance, confirm success;
 *   debit amount more than balance, confirm 422/toast and no change; as customer,
 *   reload /portal and confirm balance and history match.
 * - Role gate: owner invites staff; staff can Top Up/Debit but Adjust is unavailable
 *   (or 403s if forced); admin/owner can Adjust.
 * - Tenant isolation: tenant A tops up customer A's wallet; tenant B's /dashboard/wallets
 *   never shows that member or wallet, and direct cross-tenant memberId mutation 404s.
 */
const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";
const SEEDED_PASSWORD = "Password123!";

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
  throw new Error(
    `No console-driver invite link found for ${toEmail} in ${DEV_LOG_PATH}`,
  );
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
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function portalSignUp(
  page: import("@playwright/test").Page,
  base: string,
  { name, email }: { name: string; email: string },
) {
  await page.goto(`${base}/portal/sign-up`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(`${base}/portal`, { timeout: 15_000 });
}

test.describe("Wallet", () => {
  test("happy path: credit, debit, insufficient funds, and portal check", async ({
    page,
    browser,

  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ewallet${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const base = `http://${slug}.localtest.me:3000`;

    // 1. Owner signs up the business
    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // 2. Customer signs up via portal
    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: customerName, email: customerEmail });

    // Since the API requires the member ID for mutations, we fetch it via the portal API or we can just fetch the members list.
    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");

    // The new wallet page is supposed to mirror customers page. But without UI, we might need a way to Top Up.
    // The instruction says: "as staff, navigate to /dashboard/wallets, top up the customer's wallet, confirm the balance updates".
    // Let's go to wallets page.
    await page.goto(`${base}/dashboard/wallets`);
    await page.waitForLoadState("networkidle");

    // First Top Up. Since the wallet doesn't exist yet, maybe the UI has a general "Top Up" button that lets you select a customer,
    // or maybe the customer is visible. If not visible, we'll try to find a "Top Up" button.
    await page.getByRole("button", { name: "Top Up" }).click();

    // In the dialog, we'd select the customer by typing their name or email if it's a combobox, or just wait for them.
    // Actually, if we're testing the UI that doesn't exist, we must write what makes sense based on the design doc.
    // Phase 4 says: "dashboard/wallets/page.tsx ... Top Up / Debit dialogs ...".
    // If it's a list, the customer might not be in the list yet until they have a balance.
    // But wait, Phase 4: `useListQuery(), api.rpc.wallets.$get ...`. `GET /wallets` only returns rows where a wallet exists.
    // How does a user top up an empty wallet from `/dashboard/wallets`?
    // Maybe there's a "Top Up New Wallet" button, or "Top Up" opens a combobox for ALL customers.
    // Let's assume Top Up opens a dialog where we can type the customer's name and amount.
    await page.getByLabel(/Customer|Member/).fill(customerName);
    // Might need to select from a dropdown:
    await page.getByRole("option", { name: customerName }).click();
    await page.getByLabel("Amount").fill("50.00");
    await page.getByRole("button", { name: "Confirm Top Up" }).click();

    // The UI should show a toast, and the customer should appear in the list with 50.00
    await expect(page.getByText("Wallet topped up")).toBeVisible();
    await expect(page.getByText(customerName)).toBeVisible();
    await expect(page.getByText("50.00")).toBeVisible();

    // View history to check 'credit' row
    await page
      .getByRole("button", { name: `View history for ${customerName}` })
      .click();
    await expect(page.getByText("credit")).toBeVisible();
    await expect(page.getByText("50.00")).toBeVisible();

    // Close history dialog or go back (assuming dialog)
    await page.keyboard.press("Escape");

    // Debit amount < balance
    await page.getByRole("button", { name: `Debit ${customerName}` }).click();
    await page.getByLabel("Amount").fill("20.00");
    await page.getByLabel("Reason").fill("Snacks");
    await page.getByRole("button", { name: "Confirm Debit" }).click();

    await expect(page.getByText("Wallet debited")).toBeVisible();
    await expect(page.getByText("30.00")).toBeVisible();

    // Debit amount > balance
    await page.getByRole("button", { name: `Debit ${customerName}` }).click();
    await page.getByLabel("Amount").fill("40.00");
    await page.getByLabel("Reason").fill("Too much");
    await page.getByRole("button", { name: "Confirm Debit" }).click();

    // UI should catch 422 and toast
    await expect(page.getByText(/Insufficient balance/i)).toBeVisible();
    // Close the dialog manually if the submit didn't close it
    await page.getByRole("button", { name: "Cancel" }).click();

    // Balance should remain unchanged
    await expect(page.getByText("30.00")).toBeVisible();

    // 4. Customer checks portal
    await pageCust.reload();
    await expect(pageCust.getByText("30.00")).toBeVisible();
    await expect(pageCust.getByText("credit")).toBeVisible();
    await expect(pageCust.getByText("debit")).toBeVisible();
    await ctxCust.close();
  });

  test("role gate: staff can Top Up/Debit but Adjust is unavailable, admin/owner can Adjust", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ewalletgate${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2ewalletgateinv${uniq}`;
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const base = `http://${slug}.localtest.me:3000`;

    // 1. Owner setup
    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // Customer signs up
    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: customerName, email: customerEmail });
    await ctxCust.close();

    // Owner tops up so the wallet exists
    await page.goto(`${base}/dashboard/wallets`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Top Up" }).click();
    await page.getByLabel(/Customer|Member/).fill(customerName);
    await page.getByRole("option", { name: customerName }).click();
    await page.getByLabel("Amount").fill("10.00");
    await page.getByRole("button", { name: "Confirm Top Up" }).click();
    await expect(page.getByText("10.00")).toBeVisible();

    // Owner can adjust
    await page.getByRole("button", { name: `Adjust ${customerName}` }).click();
    await page.getByLabel("Delta").fill("-5.00");
    await page.getByLabel("Reason").fill("Correction");
    await page.getByRole("button", { name: "Confirm Adjustment" }).click();
    await expect(page.getByText("5.00")).toBeVisible();

    // Invite staff
    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // Login as staff
    await signUp(page, { name: "PW Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    // Staff checks wallets
    await page.goto(`${base}/dashboard/wallets`);
    await page.waitForLoadState("networkidle");

    // Top up and Debit should be visible
    await expect(page.getByRole("button", { name: "Top Up" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: `Debit ${customerName}` }),
    ).toBeVisible();

    // Adjust should not be visible
    await expect(
      page.getByRole("button", { name: `Adjust ${customerName}` }),
    ).toHaveCount(0);
  });

  test("tenant isolation: tenant A's wallet not visible to tenant B, and direct API 404s", async ({
    page,
    browser,

  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ewalleta${uniq}`;
    const slugB = `e2ewalletb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = "Isolation Target";
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    // Tenant A
    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });

    // Customer signs up to Tenant A
    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, baseA, { name: customerName, email: customerEmail });
    await ctxCust.close();

    // Tenant A tops up
    await page.goto(`${baseA}/dashboard/wallets`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Top Up" }).click();
    await page.getByLabel(/Customer|Member/).fill(customerName);
    await page.getByRole("option", { name: customerName }).click();
    await page.getByLabel("Amount").fill("100.00");
    await page.getByRole("button", { name: "Confirm Top Up" }).click();
    await expect(page.getByText(customerName)).toBeVisible();

    // Get the member ID from Tenant A's network request or just search members list via API.
    // For testing, we can fetch all members for Tenant A to get the memberId.
    const membersRes = await page.request.get(`${baseB}/api/rpc/members`, {
      params: { pageSize: "100" },
    });
    expect(membersRes.ok()).toBeTruthy();
    const membersBody = (await membersRes.json()) as {
      items: { id: string; email: string }[];
    };
    const memberA = membersBody.items.find((m) => m.email === customerEmail);
    expect(memberA).toBeDefined();
    const memberIdA = memberA!.id;

    // Tenant B
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });

    // Verify Tenant B doesn't see Tenant A's customer in wallets
    await pageB.goto(`${baseB}/dashboard/wallets`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(customerName)).toHaveCount(0);

    // Try to credit Tenant A's member directly from Tenant B
    const crossResCredit = await pageB.request.post(
      `${baseB}/api/rpc/wallets/${memberIdA}/credit`,
      {
        data: { amount: "10.00" },
      },
    );
    expect(crossResCredit.status()).toBe(404);

    // Try to debit Tenant A's member directly from Tenant B
    const crossResDebit = await pageB.request.post(
      `${baseB}/api/rpc/wallets/${memberIdA}/debit`,
      {
        data: { amount: "10.00", reason: "Hacked" },
      },
    );
    expect(crossResDebit.status()).toBe(404);

    // Try to adjust Tenant A's member directly from Tenant B
    const crossResAdjust = await pageB.request.post(
      `${baseB}/api/rpc/wallets/${memberIdA}/adjust`,
      {
        data: { delta: "10.00", reason: "Hacked" },
      },
    );
    expect(crossResAdjust.status()).toBe(404);

    await ctxB.close();
  });
});
