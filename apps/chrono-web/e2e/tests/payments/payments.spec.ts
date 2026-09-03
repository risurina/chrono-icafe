import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the Payments module (chrono/payment).
 */
const SEEDED_PASSWORD = "Password123!";

async function findInviteLink(toEmail: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";
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

test.describe("Payments Module", () => {
  test("happy path: staff creates payment, settles it, status badge shows paid", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2epayments${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2epaystaff${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    // 1. Owner setup
    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // 2. Invite staff
    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // 3. Login as staff
    await signUp(page, { name: "PW Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    // 4. Create a pending payment via API as instructed
    const createRes = await page.request.post(`${base}/api/rpc/payments`, {
      data: { method: "cash", amount: "10.00" },
    });
    expect(createRes.ok()).toBeTruthy();
    
    // 5. Navigate to /dashboard/payments
    await page.goto(`${base}/dashboard/payments`);
    await page.waitForLoadState("networkidle");

    // 6. Settle it by clicking 'Settle', then confirming the dialog
    await page.getByRole("button", { name: "Settle" }).click();
    await page.getByRole("button", { name: "Confirm Settle" }).click();

    // 7. Assert its status badge shows 'paid'
    // Assume there is a badge or text 'paid' (case insensitive match)
    await expect(page.getByText("paid", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  });

  test("role gate: staff sees no Void/Refund, admin sees them and can refund", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2epaygate${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2epaygateinv${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    // 1. Owner setup
    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // 2. Create a paid payment via API as Admin
    const createRes = await page.request.post(`${base}/api/rpc/payments`, {
      data: { method: "cash", amount: "20.00" },
    });
    expect(createRes.ok()).toBeTruthy();
    const payment = await createRes.json();
    const payRes = await page.request.post(`${base}/api/rpc/payments/${payment.id}/pay`, {
      data: {},
    });
    expect(payRes.ok()).toBeTruthy();

    // 3. Invite staff
    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // 4. Login as staff
    await signUp(page, { name: "PW Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    // 5. Staff checks payments
    await page.goto(`${base}/dashboard/payments`);
    await page.waitForLoadState("networkidle");

    // Assert Void and Refund are NOT rendered
    await expect(page.getByRole("button", { name: "Void" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Refund" })).toHaveCount(0);

    // 6. Login as Admin
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    
    // Quick login as owner (since owner was created first, we can just use sign-in, but since we seeded password, let's sign-in)
    await page.goto("/sign-in");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill(ownerEmail);
    await page.getByLabel("Password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    // Admin checks payments
    await page.goto(`${base}/dashboard/payments`);
    await page.waitForLoadState("networkidle");

    // 7. Assert Void and Refund ARE rendered on a paid payment row
    await expect(page.getByRole("button", { name: "Void" }).first()).toBeVisible();
    const refundButton = page.getByRole("button", { name: "Refund" }).first();
    await expect(refundButton).toBeVisible();

    // 8. Click 'Refund', confirm the dialog, assert status becomes 'refunded'
    await refundButton.click();
    await page.getByRole("button", { name: "Confirm Refund" }).click();
    await expect(page.getByText("refunded", { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  });

  test("cross-tenant isolation: tenant A's payment not visible in tenant B", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slugA = `e2epayisoa${uniq}`;
    const slugB = `e2epayisob${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    // 1. Tenant A
    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });

    // 2. Create payment in Tenant A via API
    const amount = "31.41"; // unique amount to check for absence
    const createRes = await page.request.post(`${baseA}/api/rpc/payments`, {
      data: { method: "cash", amount },
    });
    expect(createRes.ok()).toBeTruthy();
    const payment = await createRes.json();
    const paymentId = payment.id;

    // 3. Tenant B
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });

    // 4. Verify Tenant B doesn't see Tenant A's payment
    await pageB.goto(`${baseB}/dashboard/payments`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(amount)).toHaveCount(0);
    await expect(pageB.getByText(paymentId)).toHaveCount(0);
    
    // Also verify direct API 404
    const crossRes = await pageB.request.get(`${baseB}/api/rpc/payments/${paymentId}`);
    expect(crossRes.status()).toBe(404);

    await ctxB.close();
  });
});
