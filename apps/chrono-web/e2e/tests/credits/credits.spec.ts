import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the Credits module (chrono/credits).
 *
 * Per Phase 6 of .ai/plans/chrono/active/credits/README.md:
 * - Happy path: sign up a tenant (staff) + a customer; as admin, create a credit
 *   product (any_station); as staff, sell it to the customer, confirm the lot
 *   appears with the right remaining minutes; as admin, grant a free 30-minute
 *   comp with a reason, confirm it appears as a separate lot; as staff, consume
 *   10 minutes and confirm the balance drops; as the customer, reload /portal and
 *   confirm the lots/ledger match what staff recorded.
 * - Role gate: staff can Sell/Consume but Grant and Create Product are unavailable
 *   (not rendered — Can-gated); admin/owner can do both.
 * - Tenant isolation: tenant A sells a pass to its customer; tenant B's Credits
 *   view never shows that member/lot, and a direct cross-tenant memberId mutation
 *   attempt 404s.
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

/** Opens the Credits "Members" tab, searches for `customerName`, and opens
 * that member's detail (lots + ledger) view. */
async function openMemberCredits(
  page: import("@playwright/test").Page,
  base: string,
  customerName: string,
) {
  await page.goto(`${base}/dashboard/credits`);
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("Search members…").fill(customerName);
  await page.getByRole("button", { name: "View Credits" }).click();
}

async function createCreditProduct(
  page: import("@playwright/test").Page,
  base: string,
  {
    name,
    code,
    quantityMinutes,
    priceAmount,
  }: { name: string; code: string; quantityMinutes: string; priceAmount: string },
) {
  await page.goto(`${base}/dashboard/credits`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Products" }).click();
  await page.getByRole("button", { name: "Create Product" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Code").fill(code);
  await page.getByLabel("Quantity (minutes)").fill(quantityMinutes);
  await page.getByLabel("Price Amount").fill(priceAmount);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Product created.")).toBeVisible();

  // Activate it — created as "draft" by default, and only "active" products
  // are sellable (the Sell dialog only lists `status: "active"` products).
  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.getByRole("combobox").filter({ hasText: "Draft" }).click();
  await page.getByRole("option", { name: "Active" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Product updated.")).toBeVisible();
}

test.describe("Credits", () => {
  test("happy path: sell, grant, consume, and portal check", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ecredits${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const productName = "1 Hour Pass";
    const productCode = `HOUR${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    // 1. Owner signs up the business
    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // 2. Customer signs up via portal
    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: customerName, email: customerEmail });

    // 3. Owner creates and activates an any_station credit product
    await createCreditProduct(page, base, {
      name: productName,
      code: productCode,
      quantityMinutes: "60",
      priceAmount: "10.00",
    });

    // 4. Owner sells the product to the customer
    await openMemberCredits(page, base, customerName);
    await page.getByRole("button", { name: "Sell" }).click();
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: new RegExp(productName) }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Credit product sold.")).toBeVisible();
    await expect(page.getByText("60 min")).toBeVisible();
    await expect(page.getByText("Total balance: 60 minutes")).toBeVisible();

    // 5. Owner grants a free 30-minute comp
    await page.getByRole("button", { name: "Grant" }).click();
    await page.getByLabel("Quantity (minutes)").fill("30");
    await page.getByLabel("Reason").fill("Loyalty comp");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Credits granted.")).toBeVisible();
    await expect(page.getByText("Total balance: 90 minutes")).toBeVisible();
    // Two separate lots now exist (the sold pass + the comp grant).
    await expect(page.getByText("60 min")).toBeVisible();
    await expect(page.getByText("30 min")).toBeVisible();

    // 6. Owner consumes 10 minutes
    await page.getByRole("button", { name: "Consume" }).click();
    await page.getByLabel("Quantity (minutes)").fill("10");
    await page.getByLabel("Reason").fill("Station session");
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Credits consumed.")).toBeVisible();
    await expect(page.getByText("Total balance: 80 minutes")).toBeVisible();

    // Ledger reflects all three movements.
    await expect(page.getByText("purchase", { exact: false })).toBeVisible();
    await expect(page.getByText("grant", { exact: false })).toBeVisible();
    await expect(page.getByText("consume", { exact: false })).toBeVisible();

    // 7. Customer checks portal
    await pageCust.reload();
    await expect(pageCust.getByText(/80 minutes|80 min/)).toBeVisible();
    await ctxCust.close();
  });

  test("role gate: staff can Sell/Consume but Grant/Create Product are unavailable", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ecreditsgate${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2ecreditsgateinv${uniq}`;
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const productName = "Gate Pass";
    const productCode = `GATE${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    // Owner setup
    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // Customer signs up
    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: customerName, email: customerEmail });
    await ctxCust.close();

    // Owner creates + activates a product and sells it so a lot exists
    await createCreditProduct(page, base, {
      name: productName,
      code: productCode,
      quantityMinutes: "60",
      priceAmount: "5.00",
    });
    await openMemberCredits(page, base, customerName);
    await page.getByRole("button", { name: "Sell" }).click();
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: new RegExp(productName) }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("60 min")).toBeVisible();

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

    // Staff checks credits for the same member
    await openMemberCredits(page, base, customerName);

    // Sell and Consume should be visible
    await expect(page.getByRole("button", { name: "Sell" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Consume" })).toBeVisible();

    // Grant should not be visible
    await expect(page.getByRole("button", { name: "Grant" })).toHaveCount(0);

    // Products tab: Create Product should not be visible
    await page.getByRole("tab", { name: "Products" }).click();
    await expect(page.getByRole("button", { name: "Create Product" })).toHaveCount(0);
  });

  test("tenant isolation: tenant A's credits not visible to tenant B, and direct API 404s", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ecreditsa${uniq}`;
    const slugB = `e2ecreditsb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = "Isolation Credits Target";
    const productName = "Isolation Pass";
    const productCode = `ISO${uniq}`;
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    // Tenant A
    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });

    // Customer signs up to Tenant A
    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, baseA, { name: customerName, email: customerEmail });
    await ctxCust.close();

    // Tenant A creates a product and sells it
    await createCreditProduct(page, baseA, {
      name: productName,
      code: productCode,
      quantityMinutes: "60",
      priceAmount: "5.00",
    });
    await openMemberCredits(page, baseA, customerName);
    await page.getByRole("button", { name: "Sell" }).click();
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: new RegExp(productName) }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("60 min")).toBeVisible();

    // Get memberId + grantId for tenant A's customer via tenant A's own API
    const membersRes = await page.request.get(`${baseA}/api/rpc/members`, {
      params: { pageSize: "100" },
    });
    expect(membersRes.ok()).toBeTruthy();
    const membersBody = (await membersRes.json()) as {
      items: { id: string; email: string }[];
    };
    const memberA = membersBody.items.find((m) => m.email === customerEmail);
    expect(memberA).toBeDefined();
    const memberIdA = memberA!.id;

    const summaryRes = await page.request.get(
      `${baseA}/api/rpc/credits/members/${memberIdA}/summary`,
    );
    expect(summaryRes.ok()).toBeTruthy();
    const summaryBody = (await summaryRes.json()) as {
      grants: { id: string }[];
    };
    const grantIdA = summaryBody.grants[0]!.id;

    // Tenant B
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });

    // Verify Tenant B doesn't see Tenant A's customer in the Credits members list
    await pageB.goto(`${baseB}/dashboard/credits`);
    await pageB.waitForLoadState("networkidle");
    await pageB.getByPlaceholder("Search members…").fill(customerName);
    await expect(pageB.getByText(customerName)).toHaveCount(0);

    // Direct cross-tenant reads/mutations from Tenant B must 404
    const crossSummary = await pageB.request.get(
      `${baseB}/api/rpc/credits/members/${memberIdA}/summary`,
    );
    expect(crossSummary.status()).toBe(404);

    const crossConsume = await pageB.request.post(
      `${baseB}/api/rpc/credits/members/${memberIdA}/consume`,
      { data: { quantityMinutes: 5, reason: "Hacked" } },
    );
    expect(crossConsume.status()).toBe(404);

    const crossVoid = await pageB.request.post(
      `${baseB}/api/rpc/credits/grants/${grantIdA}/void`,
    );
    expect(crossVoid.status()).toBe(404);

    await ctxB.close();
  });
});
