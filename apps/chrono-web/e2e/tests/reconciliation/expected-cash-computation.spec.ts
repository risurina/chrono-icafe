import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Phase 6 (happy path) of .ai/plans/chrono/active/reconciliation/README.md.
 *
 * Expected cash = openingCashAmount + completed cash sales - refunded cash sales
 * + cash-tendered wallet contributions (see `computeExpectedCash`,
 * apps/chrono-api/src/modules/shift/service.ts). A matching count zeroes the
 * variance; a mismatched count surfaces a nonzero one, which is what makes a
 * closed shift appear in the reconciliation dashboard's variance table (the
 * page filters out zero-variance rows by design — see
 * apps/chrono-web/src/app/admin/reconciliation/page.tsx).
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
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
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
  await page.waitForURL(`${base}/member`, { timeout: 15_000 });
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
  openingCashAmount: string,
) {
  const res = await page.request.post(`${base}/api/rpc/shifts/open`, {
    data: { branchId, openingCashAmount },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { shift: { id: string } };
  return body.shift.id;
}

async function findMemberId(page: import("@playwright/test").Page, base: string, email: string) {
  const res = await page.request.get(`${base}/api/rpc/member-profiles`, {
    params: { page: "1", pageSize: "50", sort: "createdAt", order: "desc" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { memberId: string; email: string }[] };
  const match = body.items.find((m) => m.email === email);
  if (!match) throw new Error(`No member-profile found for ${email}`);
  return match.memberId;
}

test.describe("Reconciliation — expected-cash computation", () => {
  test("matching count zeroes the variance; a mismatched count surfaces the correct nonzero one", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2erecon${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const memberName = faker.person.fullName();
    const productName = `Recon Item ${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Recon Owner", email: ownerEmail, slug });
    const branchId = await createBranch(page, base, `Branch ${uniq}`);

    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: memberName, email: memberEmail });
    await ctxCust.close();
    const memberId = await findMemberId(page, base, memberEmail);

    const productRes = await page.request.post(`${base}/api/rpc/pos/products`, {
      data: { name: productName, price: "30.00", category: "other" },
    });
    expect(productRes.ok()).toBeTruthy();
    const productBody = (await productRes.json()) as { product: { id: string } };
    const productId = productBody.product.id;

    // --- Shift 1: matching count ---
    const shift1Id = await openShift(page, base, branchId, "50.00");

    // Cash sale: +30.00 cash.
    const saleRes = await page.request.post(`${base}/api/rpc/pos/sales`, {
      data: {
        branchId,
        idempotencyKey: `e2e-recon-cash-${uniq}`,
        items: [{ productId, quantity: 1 }],
        payments: [{ method: "cash", amount: "30.00" }],
      },
    });
    expect(saleRes.ok()).toBeTruthy();

    // Cash-tendered wallet top-up: +20.00 cash.
    const creditRes = await page.request.post(`${base}/api/rpc/wallets/${memberId}/credit`, {
      data: { amount: "20.00", cashTendered: true, reason: "Cash top-up" },
    });
    expect(creditRes.ok()).toBeTruthy();

    // Expected: 50.00 opening + 30.00 cash sale + 20.00 cash-tendered top-up = 100.00.
    const closeMatchRes = await page.request.post(`${base}/api/rpc/shifts/${shift1Id}/close`, {
      data: { actualCashAmount: "100.00" },
    });
    expect(closeMatchRes.ok()).toBeTruthy();
    const closeMatchBody = (await closeMatchRes.json()) as {
      shift: { expectedCashAmount: string; actualCashAmount: string; differenceAmount: string };
    };
    expect(closeMatchBody.shift.expectedCashAmount).toBe("100.00");
    expect(closeMatchBody.shift.differenceAmount).toBe("0.00");

    // The reconciliation read route reflects the same persisted figures.
    const readMatchRes = await page.request.get(`${base}/api/rpc/reconciliation/shifts/${shift1Id}`);
    expect(readMatchRes.ok()).toBeTruthy();
    const readMatchBody = (await readMatchRes.json()) as {
      summary: { expectedCashAmount: string | null; actualCashAmount: string | null; differenceAmount: string | null };
    };
    expect(readMatchBody.summary).toEqual({
      expectedCashAmount: "100.00",
      actualCashAmount: "100.00",
      differenceAmount: "0.00",
    });

    // A zero-variance closed shift is deliberately hidden from the dashboard's
    // variance table (apps/chrono-web/src/app/admin/reconciliation/page.tsx).
    await page.goto(`${base}/admin/reconciliation`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("No variance on this page.")).toBeVisible();

    // --- Shift 2: mismatched count ---
    const shift2Id = await openShift(page, base, branchId, "50.00");
    const saleRes2 = await page.request.post(`${base}/api/rpc/pos/sales`, {
      data: {
        branchId,
        idempotencyKey: `e2e-recon-cash2-${uniq}`,
        items: [{ productId, quantity: 1 }],
        payments: [{ method: "cash", amount: "30.00" }],
      },
    });
    expect(saleRes2.ok()).toBeTruthy();

    // Expected: 50.00 + 30.00 = 80.00; actual counted 70.00 => -10.00 variance.
    const closeMismatchRes = await page.request.post(`${base}/api/rpc/shifts/${shift2Id}/close`, {
      data: { actualCashAmount: "70.00" },
    });
    expect(closeMismatchRes.ok()).toBeTruthy();
    const closeMismatchBody = (await closeMismatchRes.json()) as {
      shift: { expectedCashAmount: string; differenceAmount: string };
    };
    expect(closeMismatchBody.shift.expectedCashAmount).toBe("80.00");
    expect(closeMismatchBody.shift.differenceAmount).toBe("-10.00");

    // This shift now shows up in the dashboard's variance table with the
    // correct breakdown behind "View breakdown".
    await page.goto(`${base}/admin/reconciliation`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("-10.00").first()).toBeVisible();
    await page.getByRole("button", { name: "View breakdown" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("80.00")).toBeVisible();
    await expect(dialog.getByText("70.00")).toBeVisible();
    await expect(dialog.getByText("-10.00")).toBeVisible();
  });
});
