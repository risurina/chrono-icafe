import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Tenant login paths — on a business's own host:
 *
 *   /login        → customer (member) sign-in → /portal
 *   /admin/login  → staff sign-in             → /admin (the back office)
 *   /admin/*      → the tenant back office (public URL; was /dashboard/*)
 *
 * while the apex keeps /login for staff with no tenant yet. `/admin/*` on a
 * tenant host is a next.config rewrite onto the physical `(tenant-admin)/
 * dashboard` tree, so everything here asserts the URLs a user actually sees.
 * See apps/chrono-api/AGENTS.md, "Surfaces".
 */
const PASSWORD = "Password123!";
const APEX = "http://localtest.me:3000";

async function signUpBusiness(
  page: Page,
  { name, email, slug }: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  // A fresh business lands on its back office at /admin (or the setup wizard under it).
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin(/setup)?$`), {
    timeout: 60_000,
  });
}

async function portalSignUp(
  page: Page,
  { name, email, base }: { name: string; email: string; base: string },
) {
  await page.goto(`${base}/portal/sign-up`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(new RegExp(`//${new URL(base).hostname}:3000/portal$`), {
    timeout: 30_000,
  });
}

async function fillAndSubmitSignIn(page: Page, email: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function createBranch(page: Page, base: string, name: string) {
  await page.goto(`${base}/admin/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(name)).toBeVisible();
}

test.describe("Tenant login paths", () => {
  test("staff: /admin/login signs in to /admin, nav stays under /admin, signed-out /admin/* bounces to /admin/login", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eloginst${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Login Owner", email, slug });

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    // Signed out, the back office bounces to the tenant STAFF login — not the
    // member login at /login.
    await page.goto(`${base}/admin/branches`);
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin/login`), {
      timeout: 15_000,
    });
    await expect(page.getByText("Staff sign in")).toBeVisible();

    await fillAndSubmitSignIn(page, email);
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin(/setup)?$`), {
      timeout: 30_000,
    });

    // Sidebar links render the public /admin/* URL, never the physical /dashboard tree.
    await page.getByRole("link", { name: "Branches" }).click();
    await page.waitForURL(`${base}/admin/branches`);
    await expect(page).toHaveURL(`${base}/admin/branches`);
  });

  test("customer: /login is the member sign-in → /portal; /portal/login redirects to /login; apex /login stays staff", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eloginme${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Login Owner", email: ownerEmail, slug });

    const customerCtx = await browser.newContext();
    const customerPage = await customerCtx.newPage();
    const customerEmail = faker.internet.email({ provider: "example.com" });
    await portalSignUp(customerPage, { name: "Login Customer", email: customerEmail, base });

    // Signing out of the member area lands on the tenant's /login — the member form.
    await customerPage.getByRole("button", { name: "Sign out" }).click();
    await customerPage.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/login$`), {
      timeout: 15_000,
    });
    await expect(customerPage.getByText("Customer sign in")).toBeVisible();
    await expect(customerPage.getByText("Staff sign in")).toHaveCount(0);

    await fillAndSubmitSignIn(customerPage, customerEmail);
    await customerPage.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/portal$`), {
      timeout: 30_000,
    });

    // The old member path still lands somewhere sensible on a tenant host.
    await customerPage.goto(`${base}/portal/login`);
    await customerPage.waitForURL(`${base}/login`, { timeout: 15_000 });

    // The apex /login is unchanged: staff sign-in with no tenant context.
    await customerPage.goto(`${APEX}/login`);
    await expect(customerPage.getByText("Staff sign in")).toBeVisible();

    await customerCtx.close();
  });

  test("isolation: tenant B's /admin never shows tenant A's data, from B's owner or from A's staff session", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2elogisoa${uniq}`;
    const slugB = `e2elogisob${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;
    const branchNameA = `Isolation Branch ${uniq}`;

    // Tenant A, with one distinctive branch.
    await signUpBusiness(page, { name: "Tenant A Owner", email: emailA, slug: slugA });
    await createBranch(page, baseA, branchNameA);

    // Tenant B in its own browser context — its /admin shows none of A's data.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUpBusiness(pageB, { name: "Tenant B Owner", email: emailB, slug: slugB });
    await pageB.goto(`${baseB}/admin/branches`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(branchNameA)).toHaveCount(0);
    await ctxB.close();

    // A's staff session on B's host holds no membership in B — the /admin/* alias
    // must not let it read A's rows through B's host either.
    await page.goto(`${baseB}/admin/branches`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(branchNameA)).toHaveCount(0);
  });
});
