import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

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
  await page.getByLabel("Workspace name").fill(slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
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

test.describe("Loyalty", () => {
  test("happy path: sign up, earn points, redeem points, and confirm balances", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2eloyalty${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const base = `http://${slug}.localtest.me:3000`;

    // 1. Owner signs up the workspace
    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // 2. Customer signs up via portal
    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: customerName, email: customerEmail });
    await ctxCust.close();

    // Fetch members via API to get member ID
    const membersRes = await page.request.get(`${base}/api/rpc/members`, {
      params: { pageSize: "100" },
    });
    const membersBody = (await membersRes.json()) as { items: { id: string; email: string }[] };
    const memberId = membersBody.items.find((m) => m.email === customerEmail)!.id;

    // We do an initial earn via API so they appear in the UI list
    await page.request.post(`${base}/api/rpc/loyalty/accounts/${memberId}/earn`, {
      data: { points: 10, reason: "Initial" },
    });

    // 3. Go to loyalty page
    await page.goto(`${base}/dashboard/loyalty`);
    await page.waitForLoadState("networkidle");

    // Now they should be in the list
    await expect(page.getByText(customerName)).toBeVisible();
    await expect(page.getByText("10")).toBeVisible();

    // Earn points via UI
    await page.getByRole("button", { name: "Earn" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("Points").fill("150");
    await page.getByLabel("Reason").fill("Purchases");
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(page.getByText("Points earned.")).toBeVisible();
    // 10 + 150 = 160.
    await expect(page.getByRole("cell", { name: "160" }).first()).toBeVisible();

    // Redeem points via UI
    await page.getByRole("button", { name: "Redeem" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByLabel("Points").fill("50");
    await page.getByLabel("Reason").fill("Discount");
    await page.getByRole("button", { name: "Confirm" }).click();

    await expect(page.getByText("Points redeemed.")).toBeVisible();
    // 160 - 50 = 110.
    await expect(page.getByRole("cell", { name: "110" }).first()).toBeVisible();
  });

  test("role gate: staff cannot use the Adjust action, admin/owner can", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2eloyaltygate${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2eloygateinv${uniq}`;
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const base = `http://${slug}.localtest.me:3000`;

    // 1. Owner signs up the workspace
    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // 2. Customer signs up via portal
    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: customerName, email: customerEmail });
    await ctxCust.close();

    // Fetch members via API to get member ID
    const membersRes = await page.request.get(`${base}/api/rpc/members`, {
      params: { pageSize: "100" },
    });
    const membersBody = (await membersRes.json()) as { items: { id: string; email: string }[] };
    const memberId = membersBody.items.find((m) => m.email === customerEmail)!.id;

    // Do an initial earn via API so they appear in the UI list
    await page.request.post(`${base}/api/rpc/loyalty/accounts/${memberId}/earn`, {
      data: { points: 100, reason: "Initial setup" },
    });

    // 3. Owner checks loyalty page
    await page.goto(`${base}/dashboard/loyalty`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Adjust" })).toBeVisible();

    // 4. Owner invites staff
    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // 5. Login as staff
    await signUp(page, { name: "PW Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    // 6. Staff checks loyalty page
    await page.goto(`${base}/dashboard/loyalty`);
    await page.waitForLoadState("networkidle");

    // Earn and Redeem should be visible
    await expect(page.getByRole("button", { name: "Earn" }).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Redeem" }).first()).toBeVisible();

    // Adjust should NOT be visible
    await expect(page.getByRole("button", { name: "Adjust" })).toHaveCount(0);

    // 7. Verify staff gets 403 on direct underlying request
    const adjustRes = await page.request.post(`${base}/api/rpc/loyalty/accounts/${memberId}/adjust`, {
      data: { delta: -10, reason: "Hacking" },
    });
    expect(adjustRes.status()).toBe(403);
  });

  test("tenant isolation: tenant A's loyalty account invisible from tenant B, direct GET returns 404", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slugA = `e2eloyaltya${uniq}`;
    const slugB = `e2eloyaltyb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = "Isolation Loyalty Target";
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    // 1. Tenant A signs up
    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });

    // Customer signs up to Tenant A
    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, baseA, { name: customerName, email: customerEmail });
    await ctxCust.close();

    // Fetch member ID from Tenant A
    const membersRes = await page.request.get(`${baseA}/api/rpc/members`, {
      params: { pageSize: "100" },
    });
    const membersBody = (await membersRes.json()) as { items: { id: string; email: string }[] };
    const memberIdA = membersBody.items.find((m) => m.email === customerEmail)!.id;

    // Tenant A earns points for the customer
    await page.request.post(`${baseA}/api/rpc/loyalty/accounts/${memberIdA}/earn`, {
      data: { points: 50, reason: "Tenant A initial" },
    });

    // 2. Tenant B signs up
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });

    // Verify Tenant B doesn't see Tenant A's customer in loyalty
    await pageB.goto(`${baseB}/dashboard/loyalty`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(customerName)).toHaveCount(0);

    // Try to GET Tenant A's member loyalty account directly from Tenant B
    const crossResGet = await pageB.request.get(
      `${baseB}/api/rpc/loyalty/accounts/${memberIdA}`,
    );
    expect(crossResGet.status()).toBe(404);

    await ctxB.close();
  });
});
