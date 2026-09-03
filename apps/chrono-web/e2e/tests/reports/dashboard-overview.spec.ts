import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Happy path for the Reports overview dashboard (chrono/reports).
 *
 * Per Phase 5 of .ai/plans/chrono/active/reports/README.md:
 * seed a branch, an open shift, and a cash POS sale, then confirm the
 * overview page renders the correct today's-revenue/sales-count tiles.
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
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function createBranch(page: import("@playwright/test").Page, name: string) {
  await page.goto(page.url().replace(/\/dashboard.*/, "/dashboard/branches"));
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(name)).toBeVisible();
}

async function openShift(
  page: import("@playwright/test").Page,
  base: string,
  branchName: string,
) {
  await page.goto(`${base}/dashboard/shifts`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Open Shift" }).click();
  await page.getByLabel("Branch").click();
  await page.getByRole("option", { name: new RegExp(branchName) }).click();
  await page.getByLabel("Opening cash").fill("100.00");
  await page.getByRole("button", { name: "Open shift" }).click();
}

async function createProduct(
  page: import("@playwright/test").Page,
  base: string,
  { name, price }: { name: string; price: string },
) {
  await page.goto(`${base}/dashboard/pos/products`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add product" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Price").fill(price);
  await page.getByRole("button", { name: /save|create/i }).click();
  await expect(page.getByText(name)).toBeVisible();
}

async function ringUpCashSale(
  page: import("@playwright/test").Page,
  base: string,
  branchName: string,
  productName: string,
  price: string,
) {
  await page.goto(`${base}/dashboard/pos`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Branch").click();
  await page.getByRole("option", { name: new RegExp(branchName) }).click();
  await page.getByRole("button", { name: "Walk-in" }).click();
  await page.getByRole("button", { name: productName }).click();
  await page.getByLabel("Amount").fill(price);
  await page.getByRole("button", { name: "Complete Sale" }).click();
  await expect(page.getByText(/Receipt #/)).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
}

test.describe("Reports — dashboard overview", () => {
  test("happy path: overview tiles reflect a completed cash sale and an open shift", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2erpt${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const branchName = `Branch ${uniq}`;
    const productName = `Soda ${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });
    await createBranch(page, branchName);
    await openShift(page, base, branchName);
    await createProduct(page, base, { name: productName, price: "25.00" });
    await ringUpCashSale(page, base, branchName, productName, "25.00");

    await page.goto(`${base}/dashboard/reports`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("Today's revenue")).toBeVisible();
    await expect(page.getByText("25.00")).toBeVisible();
    await expect(page.getByText("Today's sales")).toBeVisible();
    await expect(page.getByText("Open shifts")).toBeVisible();
    // A fresh tenant only ever has this one shift open right now.
    await expect(page.getByText("1", { exact: true })).toBeVisible();
  });
});
