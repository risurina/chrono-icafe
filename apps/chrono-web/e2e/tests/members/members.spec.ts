import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";

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
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });
}

test.describe("Members", () => {
  test("happy path: staff views list, approves one applicant, rejects another", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2emema${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    // 1. Sign up a tenant (staff/owner)
    await signUp(page, { name: "Tenant Owner", email, slug });

    // 2. Sign up Customer 1 (to be approved)
    const customer1Ctx = await browser.newContext();
    const customer1Page = await customer1Ctx.newPage();
    const customer1Email = faker.internet.email({ provider: "example.com" });

    await customer1Page.goto(`${base}/portal/sign-up`);
    await customer1Page.waitForLoadState("networkidle");
    await customer1Page.waitForTimeout(1000);
    await customer1Page.getByLabel("Your name").fill(faker.person.fullName());
    await customer1Page.getByLabel("Email").fill(customer1Email);
    await customer1Page.getByLabel("Password", { exact: true }).fill("Password123!");
    await customer1Page.getByRole("button", { name: /create account/i }).click();
    await customer1Page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/portal$`), {
      timeout: 30_000,
    });
    await customer1Page.getByRole("button", { name: "Apply for membership" }).click();
    await expect(customer1Page.getByText("pending", { exact: true })).toBeVisible();

    // 3. Sign up Customer 2 (to be rejected)
    const customer2Ctx = await browser.newContext();
    const customer2Page = await customer2Ctx.newPage();
    const customer2Email = faker.internet.email({ provider: "example.com" });

    await customer2Page.goto(`${base}/portal/sign-up`);
    await customer2Page.waitForLoadState("networkidle");
    await customer2Page.waitForTimeout(1000);
    await customer2Page.getByLabel("Your name").fill(faker.person.fullName());
    await customer2Page.getByLabel("Email").fill(customer2Email);
    await customer2Page.getByLabel("Password", { exact: true }).fill("Password123!");
    await customer2Page.getByRole("button", { name: /create account/i }).click();
    await customer2Page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/portal$`), {
      timeout: 30_000,
    });
    await customer2Page.getByRole("button", { name: "Apply for membership" }).click();
    await expect(customer2Page.getByText("pending", { exact: true })).toBeVisible();

    // 4. As staff, navigate to /admin/members
    await page.goto(`${base}/admin/members`);
    await page.waitForLoadState("networkidle");
    
    // Approve Customer 1
    const row1 = page.getByRole("row", { name: new RegExp(customer1Email) });
    await expect(row1.getByText("pending", { exact: true })).toBeVisible();
    await row1.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Application approved.")).toBeVisible();
    await expect(row1.getByText("approved", { exact: true })).toBeVisible();

    // Reject Customer 2
    const row2 = page.getByRole("row", { name: new RegExp(customer2Email) });
    await expect(row2.getByText("pending", { exact: true })).toBeVisible();
    await row2.getByRole("button", { name: "Reject" }).click();
    await expect(page.getByText("Application rejected.")).toBeVisible();
    await expect(row2.getByText("rejected", { exact: true })).toBeVisible();

    // 5. Confirm portal pages reflect status on reload
    await customer1Page.reload();
    await customer1Page.waitForLoadState("networkidle");
    await expect(customer1Page.getByText("approved", { exact: true })).toBeVisible();

    await customer2Page.reload();
    await customer2Page.waitForLoadState("networkidle");
    await expect(customer2Page.getByText("rejected", { exact: true })).toBeVisible();

    await customer1Ctx.close();
    await customer2Ctx.close();
  });

  test("role gate: staff can view list but cannot approve or reject", async ({ page, browser }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ememb${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2emembinv${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    // 1. Owner signs up
    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    // 2. Owner invites a staff teammate
    await page.goto(`${base}/admin/settings/crew`);
    await page.waitForLoadState("networkidle");
    const inviteInput = page.getByPlaceholder("teammate@example.com");
    await inviteInput.fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    // 3. A customer applies for membership
    const customerCtx = await browser.newContext();
    const customerPage = await customerCtx.newPage();
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();

    await customerPage.goto(`${base}/portal/sign-up`);
    await customerPage.waitForLoadState("networkidle");
    await customerPage.waitForTimeout(1000);
    await customerPage.getByLabel("Your name").fill(customerName);
    await customerPage.getByLabel("Email").fill(customerEmail);
    await customerPage.getByLabel("Password", { exact: true }).fill("Password123!");
    await customerPage.getByRole("button", { name: /create account/i }).click();
    await customerPage.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/portal$`), {
      timeout: 30_000,
    });
    await customerPage.getByRole("button", { name: "Apply for membership" }).click();
    await expect(customerPage.getByText("pending", { exact: true })).toBeVisible();
    await customerCtx.close();

    // 4. Staff signs up via invite link
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");
    await signUp(page, { name: "PW Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
      timeout: 15_000,
    });

    // 5. Staff attempts to approve and is denied
    await page.goto(`${base}/admin/members`);
    await page.waitForLoadState("networkidle");
    const row = page.getByRole("row", { name: new RegExp(customerEmail) });
    await expect(row.getByText("pending", { exact: true })).toBeVisible();
    
    await row.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Only admins can approve or reject applications.")).toBeVisible();
    
    // Status should be unchanged
    await expect(row.getByText("pending", { exact: true })).toBeVisible();

    // 6. Staff attempts to reject and is denied
    await row.getByRole("button", { name: "Reject" }).click();
    await expect(page.getByText("Only admins can approve or reject applications.")).toBeVisible();

    // Status should be unchanged
    await expect(row.getByText("pending", { exact: true })).toBeVisible();
  });

  test("tenant isolation: tenant A's applicant never appears on tenant B's list", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ememca${uniq}`;
    const slugB = `e2ememcb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    // 1. Tenant A signs up
    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });

    // 2. Customer signs up and applies to Tenant A
    const customerCtx = await browser.newContext();
    const customerPage = await customerCtx.newPage();
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = "Isolation Customer";

    await customerPage.goto(`${baseA}/portal/sign-up`);
    await customerPage.waitForLoadState("networkidle");
    await customerPage.waitForTimeout(1000);
    await customerPage.getByLabel("Your name").fill(customerName);
    await customerPage.getByLabel("Email").fill(customerEmail);
    await customerPage.getByLabel("Password", { exact: true }).fill("Password123!");
    await customerPage.getByRole("button", { name: /create account/i }).click();
    await customerPage.waitForURL(new RegExp(`//${slugA}\\.localtest\\.me:3000/portal$`), {
      timeout: 30_000,
    });
    await customerPage.getByRole("button", { name: "Apply for membership" }).click();
    await expect(customerPage.getByText("pending", { exact: true })).toBeVisible();
    await customerCtx.close();

    // Verify Customer A appears on Tenant A's list
    await page.goto(`${baseA}/admin/members`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(customerEmail)).toBeVisible();
    
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // 3. Tenant B signs up
    await signUp(page, { name: "Tenant B", email: emailB, slug: slugB });

    // 4. Verify Tenant B's list does not show Customer A
    await page.goto(`${baseB}/admin/members`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("No members yet.")).toBeVisible();
    await expect(page.getByText(customerEmail)).toHaveCount(0);

    // Search specifically for it
    await page.getByPlaceholder("Search members…").fill("Isolation");
    await expect(page.getByText("No members yet.")).toBeVisible();
    await expect(page.getByText(customerEmail)).toHaveCount(0);
  });
});
