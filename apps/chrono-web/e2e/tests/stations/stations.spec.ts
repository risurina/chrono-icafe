import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the Stations module (chrono/stations).
 *
 * Per Phase 5 of .ai/plans/chrono/active/stations/README.md:
 * - Happy path: sign up, create branch, create station group, create station,
 *   edit it, delete it.
 * - Role gate: owner invites staff, staff can create/edit but gets 403 on delete.
 * - Tenant isolation: tenant A's stations never appear in tenant B's list,
 *   and direct id-based edit/delete attempt 404s.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
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
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Workspace name").fill(slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

/** Create a branch through the real dashboard UI (mirrors branches.spec.ts). */
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

test.describe("Stations", () => {
  test("happy path: create station group, create station, edit station, delete station", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2esta${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    const groupName = "Premium PCs";
    const groupCode = `PREM-${faker.string.alphanumeric(4).toUpperCase()}`;
    const stationName = "Alpha Station";
    const stationNumber = faker.string.numeric(3);

    await signUp(page, { name: "PW Owner", email, slug });
    await createBranch(page, base, branchName);

    await page.goto(`${base}/dashboard/stations`);
    await page.waitForLoadState("networkidle");

    // 1. Create a station group
    await page.getByRole("tab", { name: "Groups & Rates" }).click();
    await page.getByRole("button", { name: "Add Group" }).click();
    await page.getByLabel("Name *").fill(groupName);
    await page.getByLabel("Code *").fill(groupCode);
    await page.getByLabel("Hourly Rate ($) *").fill("10.50");
    await page.getByRole("button", { name: "Create group" }).click();
    await expect(page.getByText("Group created.")).toBeVisible();
    await expect(page.getByText(groupName)).toBeVisible();

    // 2. Create a station assigned to that group
    await page.getByRole("tab", { name: "Stations" }).click();
    await page.getByRole("button", { name: "Add Station" }).click();
    await page.getByLabel("Number *").fill(stationNumber);
    await page.getByLabel("Name *").fill(stationName);

    await page.getByRole("combobox", { name: "None" }).click();
    await page.getByRole("option", { name: groupName }).click();

    await page.getByRole("button", { name: "Create station" }).click();
    await expect(page.getByText("Station created.")).toBeVisible();
    await expect(page.getByText(stationName)).toBeVisible();
    // In the grid view (default), the group name is shown
    await expect(page.getByText(`available • ${groupName}`)).toBeVisible();

    // 3. Edit the station (confirm group/status changes persist)
    await page.getByRole("button", { name: `Edit ${stationName}` }).click();
    
    // Change status
    const statusSelect = page.locator('button[id="s-status"]');
    await statusSelect.click();
    await page.getByRole("option", { name: "Maintenance" }).click();

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Station updated.")).toBeVisible();
    await expect(page.getByText(`maintenance • ${groupName}`)).toBeVisible();

    // 4. Delete the station
    await page.getByRole("button", { name: `Delete ${stationName}` }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Station deleted.")).toHaveCount(0); // The UI doesn't have a toast for delete success, it just reloads
    // Check it's gone
    await expect(page.getByText(stationName)).toHaveCount(0);
  });

  test("role gate: staff can create/edit but gets 403 on delete", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2estar${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2estarrinv${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    const stationName = "Staff Gate Station";
    const stationNumber = faker.string.numeric(3);

    // Setup: owner creates a branch and invites staff
    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });
    await createBranch(page, base, branchName);
    
    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");
    const inviteInput = page.getByPlaceholder("teammate@example.com");
    await inviteInput.fill(staffEmail);
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

    // Staff creates a station
    await page.goto(`${base}/dashboard/stations`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Add Station" }).click();
    await page.getByLabel("Number *").fill(stationNumber);
    await page.getByLabel("Name *").fill(stationName);
    await page.getByRole("button", { name: "Create station" }).click();
    await expect(page.getByText("Station created.")).toBeVisible();
    await expect(page.getByText(stationName)).toBeVisible();

    // Staff edits the station
    await page.getByRole("button", { name: `Edit ${stationName}` }).click();
    await page.getByLabel("Name *").fill(`${stationName} Edited`);
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Station updated.")).toBeVisible();
    await expect(page.getByText(`${stationName} Edited`)).toBeVisible();

    // Staff tries to delete the station
    await page.getByRole("button", { name: `Delete ${stationName} Edited` }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("You don't have permission to delete stations.")).toBeVisible();
    await expect(page.getByText(`${stationName} Edited`)).toBeVisible();
  });

  test("tenant isolation: stations are scoped to tenant and direct id access 404s", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slugA = `e2estatena${uniq}`;
    const slugB = `e2estatenb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;
    const branchNameA = `${faker.company.name()} Branch A`;
    const branchNameB = `${faker.company.name()} Branch B`;
    const stationNameA = "PC-01 Only Tenant A";

    // Tenant A
    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });
    await createBranch(page, baseA, branchNameA);
    const branchIdA = await findBranchId(page, branchNameA);

    // Create station for Tenant A via API to get its ID
    const createRes = await page.request.post(`${API_URL}/rpc/stations`, {
      data: {
        branchId: branchIdA,
        name: stationNameA,
        stationNumber: "001",
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const { station: stationA } = (await createRes.json()) as { station: { id: string } };

    // Tenant B
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });
    await createBranch(pageB, baseB, branchNameB);
    
    await pageB.goto(`${baseB}/dashboard/stations`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(stationNameA)).toHaveCount(0);
    
    // Search just to be sure
    await pageB.getByPlaceholder("Search stations…").fill("PC-01");
    await expect(pageB.getByText("No stations yet.")).toBeVisible();
    await expect(pageB.getByText(stationNameA)).toHaveCount(0);

    // Direct API attempt from Tenant B to fetch Tenant A's station
    const crossResGet = await pageB.request.get(`${API_URL}/rpc/stations/${stationA.id}`);
    expect(crossResGet.status()).toBe(404);

    // Direct API attempt from Tenant B to edit Tenant A's station
    const crossResPatch = await pageB.request.patch(`${API_URL}/rpc/stations/${stationA.id}`, {
      data: { name: "Hacked" }
    });
    expect(crossResPatch.status()).toBe(404);

    // Direct API attempt from Tenant B to delete Tenant A's station
    const crossResDel = await pageB.request.delete(`${API_URL}/rpc/stations/${stationA.id}`);
    expect(crossResDel.status()).toBe(404);

    await ctxB.close();
  });
});
