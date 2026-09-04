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

const isBranchList = (r: import("@playwright/test").Response) =>
  r.url().includes("/rpc/branches") && r.request().method() === "GET";

async function createBranch(page: Page, base: string, name: string) {
  await page.goto(`${base}/admin/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(name);
  const created = page.waitForResponse(
    (r) => r.url().includes("/rpc/branches") && r.request().method() === "POST",
    { timeout: 30_000 },
  );
  await page.getByRole("button", { name: "Create branch" }).click();
  expect((await created).status()).toBe(201);
  await expect(page.getByText(name)).toBeVisible({ timeout: 30_000 });
}

/** Load a host's branch list and hand back the API response it rendered from. */
async function openBranchList(page: Page, base: string) {
  const list = page.waitForResponse(isBranchList, { timeout: 30_000 });
  await page.goto(`${base}/admin/branches`);
  return list;
}

test.describe("Tenant login paths", () => {
  // Every test here does two sign-in cycles (business sign-up, then a fresh
  // sign-in) and each RPC costs several DB round-trips to a remote Postgres, so
  // the config's 90s budget is not enough for this spec.
  test.describe.configure({ timeout: 270_000 });

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

    // Sidebar links render the public /admin/* URL, never the physical /dashboard
    // tree (a fresh business lands on the setup wizard, but the same sidebar wraps
    // it — check the href directly rather than clicking through the wizard).
    await expect(page.getByRole("link", { name: "Branches" })).toHaveAttribute(
      "href",
      "/admin/branches",
    );
    await page.goto(`${base}/admin/branches`);
    await expect(page).toHaveURL(`${base}/admin/branches`);
    await expect(page.getByRole("heading", { name: "Branches" })).toBeVisible();
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
    // The member form links to the staff login but must not BE the staff form.
    await expect(customerPage.getByText("Back-office access for this business.")).toHaveCount(0);
    await expect(customerPage.getByRole("link", { name: "Staff sign in" })).toHaveAttribute(
      "href",
      "/admin/login",
    );

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
    // Wait for B's list to actually load (an empty list must not pass vacuously).
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUpBusiness(pageB, { name: "Tenant B Owner", email: emailB, slug: slugB });
    const listB = await openBranchList(pageB, baseB);
    expect(listB.status()).toBe(200);
    await expect(pageB.getByText("No branches yet.")).toBeVisible({ timeout: 30_000 });
    await expect(pageB.getByText(branchNameA)).toHaveCount(0);
    await ctxB.close();

    // A's staff session on B's host holds no membership in B — the /admin/* alias
    // must not let it read A's rows through B's host either: the API refuses the
    // list outright rather than returning anything.
    const listCross = await openBranchList(page, baseB);
    expect(listCross.status()).toBe(403); // tenantMiddleware: "Not a member of this tenant"
    await expect(page.getByText(branchNameA)).toHaveCount(0);
  });
});
