import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Browser coverage for the global DataTable stack (search/sort/paginate/view
 * toggle, route-driven state) on the Projects listing page. The role-gate and
 * cross-tenant isolation legs are covered here at the UI level; the exhaustive
 * permission-matrix and RLS proofs live in `pnpm test:e2e`
 * (`apps/api/src/e2e/run.ts`) and `pnpm --filter @agora/api rls:proof`.
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
  await page.getByLabel("Workspace name").fill(slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

test.describe("Projects listing (global DataTable)", () => {
  test("search, sort, paginate, and switch view update the URL", async ({ page }) => {
    const uniq = Date.now();
    const slug = `e2elist${uniq}`;
    const email = `pwlist${uniq}@example.com`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Listing", email, slug });

    await page.goto(`${base}/dashboard/projects`);
    await page.waitForLoadState("networkidle");

    // Create two projects to search/sort over.
    for (const name of ["Zeta Project", "Alpha Project"]) {
      await page.getByPlaceholder("New project name").fill(name);
      await page.getByRole("button", { name: "Add" }).click();
      await expect(page.getByText(name)).toBeVisible();
    }

    // Search narrows the list and writes `q` to the URL.
    await page.getByPlaceholder("Search projects…").fill("Alpha");
    await expect(page).toHaveURL(/[?&]q=Alpha/, { timeout: 5_000 });
    await expect(page.getByText("Alpha Project")).toBeVisible();
    await expect(page.getByText("Zeta Project")).toHaveCount(0);

    await page.getByPlaceholder("Search projects…").fill("");
    await expect(page).not.toHaveURL(/[?&]q=/, { timeout: 5_000 });

    // Sort by name toggles order in the URL.
    await page.getByRole("button", { name: /^Name/ }).click();
    await expect(page).toHaveURL(/[?&]sort=name/);
    await expect(page).toHaveURL(/[?&]order=asc/);
    await page.getByRole("button", { name: /^Name/ }).click();
    await expect(page).toHaveURL(/[?&]order=desc/);

    // View toggle switches to the grid and updates the URL.
    await page.getByRole("button", { name: "Grid view" }).click();
    await expect(page).toHaveURL(/[?&]view=grid/);
    await expect(page.getByText("Alpha Project")).toBeVisible();
    await page.getByRole("button", { name: "Table view" }).click();
    await expect(page).not.toHaveURL(/[?&]view=grid/);

    // Back/forward restores a prior discrete state (view toggle pushed history).
    await page.goBack();
    await expect(page).toHaveURL(/[?&]view=grid/);
  });

  test("a staff-role member is blocked from deleting a project", async ({ page }) => {
    const uniq = Date.now();
    const slug = `e2elistr${uniq}`;
    const ownerEmail = `pwlistr${uniq}@example.com`;
    const staffEmail = `ronnie.isurina+${uniq}@gmail.com`;
    const staffSlug = `e2elistrinv${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "PW Owner", email: ownerEmail, slug });

    await page.goto(`${base}/dashboard/projects`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("New project name").fill("Gate Project");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText("Gate Project")).toBeVisible();

    // Invite a teammate (default role: staff — project:create only, no delete).
    await page.goto(`${base}/dashboard/settings/members`);
    await page.waitForLoadState("networkidle");
    const inviteInput = page.getByPlaceholder("teammate@example.com");
    await inviteInput.fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite" }).click();
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

    // Staff can list/search/sort (GET is ungated) but delete is refused server-side.
    await page.goto(`${base}/dashboard/projects`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Gate Project")).toBeVisible();
    await page.getByRole("button", { name: "Delete Gate Project" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText("Only admins can delete projects.")).toBeVisible();
    await expect(page.getByText("Gate Project")).toBeVisible();
  });

  test("a project from one tenant never appears in another tenant's list", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slugA = `e2elista${uniq}`;
    const slugB = `e2elistb${uniq}`;
    const emailA = `pwlista${uniq}@example.com`;
    const emailB = `pwlistb${uniq}@example.com`;

    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });
    await page.goto(`http://${slugA}.localtest.me:3000/dashboard/projects`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("New project name").fill("Acme Only Project");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByText("Acme Only Project")).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await signUp(page, { name: "Tenant B", email: emailB, slug: slugB });
    await page.goto(`http://${slugB}.localtest.me:3000/dashboard/projects`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("Search projects…").fill("Acme Only");
    await expect(page.getByText("No projects yet.")).toBeVisible();
    await expect(page.getByText("Acme Only Project")).toHaveCount(0);
  });
});
