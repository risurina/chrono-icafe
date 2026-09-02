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
  await page.getByLabel("Workspace name").fill(slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

/** Create a branch through the real dashboard UI. */
async function createBranch(
  page: import("@playwright/test").Page,
  base: string,
  name: string,
): Promise<void> {
  await page.goto(`${base}/dashboard/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(name)).toBeVisible();
}

/** Look up a branch's id from the tenant-scoped list. */
async function findBranchId(
  page: import("@playwright/test").Page,
  name: string,
): Promise<string> {
  const res = await page.request.get(`${API_URL}/rpc/branches`, {
    params: { pageSize: "100" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; name: string }[] };
  const branch = body.items.find((b) => b.name === name);
  expect(branch).toBeTruthy();
  return branch!.id;
}

test.describe("Public Stations Availability", () => {
  test("happy path, cross-tenant isolation, and 404s", async ({ page, browser }) => {
    const uniq = faker.string.alphanumeric(8);
    const slugA = `e2epubstaa${uniq}`;
    const slugB = `e2epubstab${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;
    
    // Seed Tenant A
    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });
    await createBranch(page, baseA, "Branch A");
    const branchIdA = await findBranchId(page, "Branch A");

    // Create stations for Tenant A via API
    await page.request.post(`${API_URL}/rpc/stations`, {
      data: { branchId: branchIdA, name: "PC-01", stationNumber: "01", status: "available" }
    });
    await page.request.post(`${API_URL}/rpc/stations`, {
      data: { branchId: branchIdA, name: "PC-02", stationNumber: "02", status: "available" }
    });
    await page.request.post(`${API_URL}/rpc/stations`, {
      data: { branchId: branchIdA, name: "PC-03", stationNumber: "03", status: "maintenance" }
    });

    // Seed Tenant B using a separate context so it has its own auth/session
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });
    await createBranch(pageB, baseB, "Branch B");
    const branchIdB = await findBranchId(pageB, "Branch B");

    // Create stations for Tenant B via API
    await pageB.request.post(`${API_URL}/rpc/stations`, {
      data: { branchId: branchIdB, name: "Mac-01", stationNumber: "M1", status: "available" }
    });
    await pageB.request.post(`${API_URL}/rpc/stations`, {
      data: { branchId: branchIdB, name: "Mac-02", stationNumber: "M2", status: "offline" }
    });
    await ctxB.close();

    // 1. "Public accessibility without a session" case & Happy path
    // Clear cookies/session so we test completely anonymous access
    await page.context().clearCookies();
    
    await page.goto(`${baseA}/stations`);
    await page.waitForLoadState("networkidle");

    // Ensure we are NOT redirected to login
    expect(page.url()).toContain(`${baseA}/stations`);
    
    // Assert aggregate counts for Tenant A
    await expect(page.locator("text=Total Stations").locator("..").locator("div.text-3xl")).toHaveText("3");
    await expect(page.locator("text=Available").locator("..").locator("div.text-3xl")).toHaveText("2");
    await expect(page.locator("text=In Use / Offline").locator("..").locator("div.text-3xl")).toHaveText("1");

    // Assert Tenant A's stations render
    await expect(page.getByText("PC-01")).toBeVisible();
    await expect(page.getByText("01")).toBeVisible();
    await expect(page.getByText("PC-02")).toBeVisible();
    await expect(page.getByText("02")).toBeVisible();
    await expect(page.getByText("PC-03")).toBeVisible();
    await expect(page.getByText("03")).toBeVisible();
    
    // Check status badges for Tenant A
    const pc03Card = page.locator(".overflow-hidden").filter({ hasText: "PC-03" });
    await expect(pc03Card.getByText("Maintenance")).toBeVisible();

    // 2. Cross-tenant isolation (Tenant A does not see Tenant B)
    await expect(page.getByText("Mac-01")).toHaveCount(0);
    await expect(page.getByText("M1")).toHaveCount(0);

    // Visit Tenant B's public page
    await page.goto(`${baseB}/stations`);
    await page.waitForLoadState("networkidle");

    // Ensure we are NOT redirected to login
    expect(page.url()).toContain(`${baseB}/stations`);

    // Assert Tenant B's stations render
    await expect(page.getByText("Mac-01")).toBeVisible();
    await expect(page.getByText("M1")).toBeVisible();
    await expect(page.getByText("Mac-02")).toBeVisible();
    await expect(page.getByText("M2")).toBeVisible();
    
    const mac02Card = page.locator(".overflow-hidden").filter({ hasText: "Mac-02" });
    await expect(mac02Card.getByText("Offline")).toBeVisible();

    // Cross-tenant isolation (Tenant B does not see Tenant A)
    await expect(page.getByText("PC-01")).toHaveCount(0);
    await expect(page.getByText("01")).toHaveCount(0);

    // 3. Unknown-host / suspended-tenant case
    const unknownSlug = `e2eunknown${uniq}`;
    const baseUnknown = `http://${unknownSlug}.localtest.me:3000`;
    
    // We expect a 404 response
    const res = await page.goto(`${baseUnknown}/stations`);
    expect(res?.status()).toBe(404);
  });
});
