import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
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

/** Create a branch through the real dashboard UI. */
async function createBranch(
  page: import("@playwright/test").Page,
  base: string,
  name: string,
): Promise<void> {
  await page.goto(`${base}/admin/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(name)).toBeVisible();
}

test.describe("Shifts", () => {
  test("happy path: open a shift, assert it lists as open, close it, assert it lists as closed", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eshift${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    await signUp(page, { name: "PW Owner", email, slug });
    await createBranch(page, base, branchName);

    await page.goto(`${base}/admin/shifts`);
    await page.waitForLoadState("networkidle");

    // Open shift
    await page.getByRole("button", { name: "Open Shift" }).click();
    await page.getByLabel("Branch").click();
    await page.getByRole("option", { name: new RegExp(branchName) }).click();
    await page.getByLabel("Opening cash").fill("150.00");
    await page.getByRole("button", { name: "Open shift" }).click();

    await expect(page.getByText("Shift opened.")).toBeVisible();

    // The shift lists as open
    const row = page.getByRole("row", { name: /150\.00/ });
    await expect(row.getByText("Open", { exact: true })).toBeVisible();

    // Close shift
    await row.getByRole("button", { name: "Close Shift" }).click();
    await page.getByLabel("Actual cash counted").fill("350.50");
    await page.getByRole("button", { name: "Close shift" }).click();

    await expect(page.getByText("Shift closed.")).toBeVisible();

    // The shift lists as closed, showing actual cash and "—" for expected/variance
    await expect(row.getByText("Closed", { exact: true })).toBeVisible();
    await expect(row.getByText("350.50")).toBeVisible();
    // Verify "—" is rendered for expected/variance. Since there are multiple columns, 
    // it's tricky to assert on a single character, but we can verify it exists in the row.
    // The "—" character is used directly in the page component.
    await expect(row.getByText("—")).toHaveCount(2); // One for closedAt (if not rendered?), actually closedAt is rendered. One for expectedVariance. Let's not rely on count, just that it exists.
  });

  test("business-rule gate: prevents opening a second shift in the same branch when one is already open", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eshift2${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    await signUp(page, { name: "PW Owner", email, slug });
    await createBranch(page, base, branchName);

    await page.goto(`${base}/admin/shifts`);
    await page.waitForLoadState("networkidle");

    // Open first shift
    await page.getByRole("button", { name: "Open Shift" }).click();
    await page.getByLabel("Branch").click();
    await page.getByRole("option", { name: new RegExp(branchName) }).click();
    await page.getByLabel("Opening cash").fill("100.00");
    await page.getByRole("button", { name: "Open shift" }).click();

    await expect(page.getByText("Shift opened.")).toBeVisible();

    // Try to open a second shift in the same branch
    await page.getByRole("button", { name: "Open Shift" }).click();
    await page.getByLabel("Branch").click();
    await page.getByRole("option", { name: new RegExp(branchName) }).click();
    await page.getByLabel("Opening cash").fill("200.00");
    await page.getByRole("button", { name: "Open shift" }).click();

    // Assert 409 toast error appears
    await expect(page.getByText("You already have an open shift at this branch.")).toBeVisible();
    
    // Cancel the dialog
    await page.keyboard.press('Escape');

    // Ensure no second row is added (there should only be one row with '100.00' and not one with '200.00')
    await expect(page.getByRole("row", { name: /100\.00/ })).toHaveCount(1);
    await expect(page.getByRole("row", { name: /200\.00/ })).toHaveCount(0);
  });

  test("an unauthenticated request to /rpc/shifts/open is refused", async ({ request }) => {
    // No sign-up/sign-in in this test at all — a bare, cookie-less request.
    const res = await request.post(`${API_URL}/rpc/shifts/open`, {
      data: {
        branchId: "does-not-matter",
        openingCashAmount: "100.00",
      }
    });
    expect(res.ok()).toBeFalsy();
    expect([401, 403]).toContain(res.status());
  });

  test("tenant isolation: tenant A's shift never appears in tenant B's view, and tenant B cannot close it", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2eshifta${uniq}`;
    const slugB = `e2eshiftb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;
    const branchNameA = `${faker.company.name()} Branch`;
    const branchNameB = `${faker.company.name()} Branch`;

    // Tenant A: branch, and an open shift on it.
    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });
    await createBranch(page, baseA, branchNameA);
    
    // Look up the branch id to use with page.request
    const res = await page.request.get(`${API_URL}/rpc/branches`, { params: { pageSize: "100" } });
    const body = (await res.json()) as { items: { id: string; name: string }[] };
    const branchIdA = body.items.find((b) => b.name === branchNameA)!.id;

    const createRes = await page.request.post(`${API_URL}/rpc/shifts/open`, {
      data: {
        branchId: branchIdA,
        openingCashAmount: "250.00",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const { shift } = (await createRes.json()) as { shift: { id: string } };

    // Tenant B: its own branch, its own board.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });
    await createBranch(pageB, baseB, branchNameB);

    await pageB.goto(`${baseB}/admin/shifts`);
    await pageB.waitForLoadState("networkidle");
    
    // Check that Tenant A's shift isn't visible in Tenant B's UI
    await expect(pageB.getByText("250.00")).toHaveCount(0);
    // Explicitly check empty state or similar, verifying isolation. 
    await expect(pageB.getByText("No shifts yet.")).toBeVisible();

    // Direct POST by id, from tenant B's own session, against tenant A's shift id → 404.
    const crossRes = await pageB.request.post(`${API_URL}/rpc/shifts/${shift.id}/close`, {
      data: { actualCashAmount: "250.00" }
    });
    expect(crossRes.status()).toBe(404);

    await ctxB.close();
  });
});
