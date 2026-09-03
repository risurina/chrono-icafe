import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * Browser coverage for the Branches module (chrono/branches). Happy path,
 * role gate, and cross-tenant isolation — mirrors
 * apps/chrono-web/e2e/tests/data-listing/projects-listing.spec.ts's
 * structure and signUp() helper.
 */
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
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

test.describe("Branches", () => {
  test("create (auto-generated code), edit, and disable a branch", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ebr${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    await signUp(page, { name: "PW Owner", email, slug });

    await page.goto(`${base}/dashboard/branches`);
    await page.waitForLoadState("networkidle");

    // Create with name only — confirms the server auto-generates `code`.
    await page.getByRole("button", { name: "Add Branch" }).click();
    await page.getByLabel("Name").fill(branchName);
    await page.getByRole("button", { name: "Create branch" }).click();
    await expect(page.getByText(branchName)).toBeVisible();

    // Edit — confirms PATCH.
    await page.getByRole("button", { name: `Edit ${branchName}` }).click();
    await page.getByLabel("Address").fill("123 Test Street");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Branch updated.")).toBeVisible();

    // Disable via the inline status toggle — disabled is not deleted, the
    // row must still list.
    await page.getByRole("button", { name: `Disable ${branchName}` }).click();
    await expect(page.getByText("Branch disabled.")).toBeVisible();
    await expect(page.getByText(branchName)).toBeVisible();
    await expect(page.getByRole("button", { name: `Enable ${branchName}` })).toBeVisible();
  });

  test("search, sort, and switch view update the URL", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ebrl${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Listing", email, slug });

    await page.goto(`${base}/dashboard/branches`);
    await page.waitForLoadState("networkidle");

    for (const name of ["Zeta Branch", "Alpha Branch"]) {
      await page.getByRole("button", { name: "Add Branch" }).click();
      await page.getByLabel("Name").fill(name);
      await page.getByRole("button", { name: "Create branch" }).click();
      await expect(page.getByText(name)).toBeVisible();
    }

    await page.getByPlaceholder("Search branches…").fill("Alpha");
    await expect(page).toHaveURL(/[?&]q=Alpha/, { timeout: 5_000 });
    await expect(page.getByText("Alpha Branch")).toBeVisible();
    await expect(page.getByText("Zeta Branch")).toHaveCount(0);

    await page.getByPlaceholder("Search branches…").fill("");
    await expect(page).not.toHaveURL(/[?&]q=/, { timeout: 5_000 });

    await page.getByRole("button", { name: /^Name/ }).click();
    await expect(page).toHaveURL(/[?&]sort=name/);
    await expect(page).toHaveURL(/[?&]order=asc/);

    await page.getByRole("button", { name: "Grid view" }).click();
    await expect(page).toHaveURL(/[?&]view=grid/);
    await expect(page.getByText("Alpha Branch")).toBeVisible();
  });

  test("a staff-role member can list but not create a branch", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ebrr${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2ebrrinv${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Gate Branch`;

    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    await page.goto(`${base}/dashboard/branches`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Add Branch" }).click();
    await page.getByLabel("Name").fill(branchName);
    await page.getByRole("button", { name: "Create branch" }).click();
    await expect(page.getByText(branchName)).toBeVisible();

    // Invite a teammate (default role: staff — no branch:create/:update).
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
    await signUp(page, { name: "PW Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    // Staff can list (GET is ungated) but create is refused server-side.
    await page.goto(`${base}/dashboard/branches`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(branchName)).toBeVisible();
    await page.getByRole("button", { name: "Add Branch" }).click();
    await page.getByLabel("Name").fill("Staff Attempt Branch");
    await page.getByRole("button", { name: "Create branch" }).click();
    await expect(page.getByText("Only admins can manage branches.")).toBeVisible();
    await expect(page.getByText("Staff Attempt Branch")).toHaveCount(0);
  });

  test("a branch from one tenant never appears in another tenant's list", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2ebra${uniq}`;
    const slugB = `e2ebrb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const branchName = `${faker.company.name()} Acme Only Branch`;

    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });
    await page.goto(`http://${slugA}.localtest.me:3000/dashboard/branches`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Add Branch" }).click();
    await page.getByLabel("Name").fill(branchName);
    await page.getByRole("button", { name: "Create branch" }).click();
    await expect(page.getByText(branchName)).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await signUp(page, { name: "Tenant B", email: emailB, slug: slugB });
    await page.goto(`http://${slugB}.localtest.me:3000/dashboard/branches`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("Search branches…").fill(branchName);
    await expect(page.getByText("No branches yet.")).toBeVisible();
    await expect(page.getByText(branchName)).toHaveCount(0);
  });
});
