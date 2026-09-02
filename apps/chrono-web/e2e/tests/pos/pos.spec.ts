import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the POS module (chrono/pos).
 *
 * Per Phase 6 of .ai/plans/chrono/active/pos/README.md:
 * - Happy path: open a shift, create a product, ring up a cash walk-in sale (receipt
 *   shows), ring up a wallet-tendered sale for a pre-funded member (wallet debits),
 *   close the shift and confirm expectedCashAmount/differenceAmount reflect the cash
 *   sale (the shifts UI doesn't render these fields — asserted via the close route's
 *   own JSON response instead of the DOM).
 * - Business-rule / role gate: a cash sale with no open shift 409s as a toast; staff
 *   can sell but Refund is unavailable, admin/owner can refund and the refunded sale's
 *   wallet portion is credited back.
 * - Tenant isolation: tenant A's catalog/sale history never appear for tenant B; a
 *   direct cross-tenant productId/sale-memberId mutation attempt 404s.
 */
const SEEDED_PASSWORD = "Password123!";

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
  throw new Error(`No console-driver invite link found for ${toEmail} in ${DEV_LOG_PATH}`);
}

async function createBranch(page: import("@playwright/test").Page, base: string, name: string) {
  const res = await page.request.post(`${base}/api/rpc/branches`, {
    data: { name, code: name.slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, "X"), status: "active" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { branch: { id: string } };
  return body.branch.id;
}

async function openShift(
  page: import("@playwright/test").Page,
  base: string,
  branchId: string,
  openingCashAmount = "0.00",
) {
  const res = await page.request.post(`${base}/api/rpc/shifts`, {
    data: { branchId, openingCashAmount },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { shift: { id: string } };
  return body.shift.id;
}

test.describe("POS", () => {
  test("happy path: cash walk-in sale, wallet-tendered member sale, shift close reconciliation", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2epos${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const memberName = faker.person.fullName();
    const productName = `Soda ${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "POS Owner", email: ownerEmail, slug });

    const branchId = await createBranch(page, base, `Branch ${uniq}`);
    await openShift(page, base, branchId, "100.00");

    // Member signs up and gets a pre-funded wallet.
    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: memberName, email: memberEmail });
    await ctxCust.close();

    await page.goto(`${base}/dashboard/wallets`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Top Up" }).click();
    await page.getByLabel(/Customer|Member/).fill(memberName);
    await page.getByRole("option", { name: memberName }).click();
    await page.getByLabel("Amount").fill("50.00");
    await page.getByRole("button", { name: "Confirm Top Up" }).click();
    await expect(page.getByText("Wallet topped up")).toBeVisible();

    // Create a product via the API (products dialog is covered implicitly through
    // the routes it calls; direct API keeps this test focused on the checkout flow).
    const productRes = await page.request.post(`${base}/api/rpc/pos/products`, {
      data: { name: productName, price: "25.00", category: "drink" },
    });
    expect(productRes.ok()).toBeTruthy();

    // 1. Cash walk-in sale.
    await page.goto(`${base}/dashboard/pos`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("Search products…").fill(productName);
    await page.getByRole("button", { name: new RegExp(productName) }).click();
    await page.getByLabel("Amount").last().fill("25.00");
    await page.getByRole("button", { name: "Complete Sale" }).click();
    await expect(page.getByText("Sale completed.")).toBeVisible();
    await expect(page.getByText(/^Receipt #/)).toBeVisible();
    await page.keyboard.press("Escape");

    // 2. Wallet-tendered sale for the member.
    await page.getByPlaceholder("Search products…").fill(productName);
    await page.getByRole("button", { name: new RegExp(productName) }).click();
    await page.getByRole("button", { name: "Member" }).click();
    await page.getByLabel("Search member").fill(memberName);
    await page.getByRole("button", { name: new RegExp(memberName) }).click();
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Wallet" }).click();
    await page.getByLabel("Amount").last().fill("25.00");
    await page.getByRole("button", { name: "Complete Sale" }).click();
    await expect(page.getByText("Sale completed.")).toBeVisible();

    // Wallet balance dropped by the wallet-tendered sale amount (50 - 25 = 25).
    await page.goto(`${base}/dashboard/wallets`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("25.00")).toBeVisible();

    // 3. Close the shift; confirm expected/difference cash via the close route's
    // own response (the shifts dashboard table doesn't render these fields).
    await page.goto(`${base}/dashboard/shifts`);
    await page.waitForLoadState("networkidle");
    const shiftsRes = await page.request.get(`${base}/api/rpc/shifts`, {
      params: { page: "1", pageSize: "10", status: "open" },
    });
    const shiftsBody = (await shiftsRes.json()) as { items: { id: string }[] };
    const openShiftId = shiftsBody.items[0]!.id;
    const closeRes = await page.request.post(`${base}/api/rpc/shifts/${openShiftId}/close`, {
      data: { actualCashAmount: "125.00" },
    });
    expect(closeRes.ok()).toBeTruthy();
    const closeBody = (await closeRes.json()) as {
      shift: { expectedCashAmount: string; differenceAmount: string };
    };
    // Opening cash 100.00 + one cash sale of 25.00 (the wallet-tendered sale doesn't
    // add cash) = 125.00 expected; actual 125.00 counted => zero difference.
    expect(closeBody.shift.expectedCashAmount).toBe("125.00");
    expect(closeBody.shift.differenceAmount).toBe("0.00");
  });

  test("business-rule / role gate: no-open-shift 409s, staff cannot refund, admin can and wallet is credited back", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2eposgate${uniq}`;
    const staffSlug = `e2eposgateinv${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const memberName = faker.person.fullName();
    const productName = `Chips ${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "POS Owner", email: ownerEmail, slug });
    const branchId = await createBranch(page, base, `Branch ${uniq}`);

    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: memberName, email: memberEmail });
    await ctxCust.close();

    await page.goto(`${base}/dashboard/wallets`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Top Up" }).click();
    await page.getByLabel(/Customer|Member/).fill(memberName);
    await page.getByRole("option", { name: memberName }).click();
    await page.getByLabel("Amount").fill("50.00");
    await page.getByRole("button", { name: "Confirm Top Up" }).click();
    await expect(page.getByText("Wallet topped up")).toBeVisible();

    const productRes = await page.request.post(`${base}/api/rpc/pos/products`, {
      data: { name: productName, price: "15.00", category: "snack" },
    });
    expect(productRes.ok()).toBeTruthy();

    // No open shift yet — a cash sale must 409 and surface a toast.
    await page.goto(`${base}/dashboard/pos`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("Search products…").fill(productName);
    await page.getByRole("button", { name: new RegExp(productName) }).click();
    await page.getByLabel("Amount").last().fill("15.00");
    await page.getByRole("button", { name: "Complete Sale" }).click();
    await expect(page.getByText(/could not complete sale/i)).toBeVisible();

    // Open the shift and ring up a wallet-tendered sale for the member instead
    // (so there's a refundable wallet portion).
    await openShift(page, base, branchId, "0.00");
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("Search products…").fill(productName);
    await page.getByRole("button", { name: new RegExp(productName) }).click();
    await page.getByRole("button", { name: "Member" }).click();
    await page.getByLabel("Search member").fill(memberName);
    await page.getByRole("button", { name: new RegExp(memberName) }).click();
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Wallet" }).click();
    await page.getByLabel("Amount").last().fill("15.00");
    await page.getByRole("button", { name: "Complete Sale" }).click();
    await expect(page.getByText("Sale completed.")).toBeVisible();

    // Invite staff.
    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await signUp(page, { name: "POS Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    // Staff sees sale history but no Refund action.
    await page.goto(`${base}/dashboard/pos/history`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(productName).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Refund" })).toHaveCount(0);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // Sign back in as owner and refund; the wallet-tendered portion is credited back.
    await page.goto(`${base}/dashboard/pos/history`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Refund" }).first().click();
    await page.getByLabel("Reason").fill("Customer changed mind");
    await page.getByRole("button", { name: "Confirm refund" }).click();
    await expect(page.getByText("Sale refunded.")).toBeVisible();

    await page.goto(`${base}/dashboard/wallets`);
    await page.waitForLoadState("networkidle");
    // Balance: 50.00 topped up - 15.00 wallet sale + 15.00 refunded back = 50.00.
    await expect(page.getByText("50.00")).toBeVisible();
  });

  test("tenant isolation: tenant A's products/sales invisible to tenant B, direct cross-tenant mutation 404s", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slugA = `e2eposa${uniq}`;
    const slugB = `e2eposb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const productName = `Isolation Item ${uniq}`;
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });
    const branchIdA = await createBranch(page, baseA, `Branch A ${uniq}`);
    await openShift(page, baseA, branchIdA, "0.00");

    const productRes = await page.request.post(`${baseA}/api/rpc/pos/products`, {
      data: { name: productName, price: "10.00", category: "other" },
    });
    expect(productRes.ok()).toBeTruthy();
    const productBody = (await productRes.json()) as { product: { id: string } };
    const productIdA = productBody.product.id;

    const saleRes = await page.request.post(`${baseA}/api/rpc/pos/sales`, {
      data: {
        branchId: branchIdA,
        idempotencyKey: `e2e-${uniq}`,
        items: [{ productId: productIdA, quantity: 1 }],
        payments: [{ method: "cash", amount: "10.00" }],
      },
    });
    expect(saleRes.ok()).toBeTruthy();
    const saleBody = (await saleRes.json()) as { sale: { id: string } };
    const saleIdA = saleBody.sale.id;

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });

    await pageB.goto(`${baseB}/dashboard/pos/products`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(productName)).toHaveCount(0);

    await pageB.goto(`${baseB}/dashboard/pos/history`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(productName)).toHaveCount(0);

    // Direct cross-tenant mutation attempts must 404, not leak/succeed.
    const crossPatch = await pageB.request.patch(`${baseB}/api/rpc/pos/products/${productIdA}`, {
      data: { price: "999.00" },
    });
    expect(crossPatch.status()).toBe(404);

    const crossRefund = await pageB.request.post(`${baseB}/api/rpc/pos/sales/${saleIdA}/refund`, {
      data: { reason: "Hacked" },
    });
    expect(crossRefund.status()).toBe(404);

    await ctxB.close();
  });
});
