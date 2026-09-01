import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the platform admin support-tooling additions to the
 * org detail page (`/admin/organizations/:id`): the support ticket ref
 * (link/update/clear, admin-only) and the read-only "recent activity" glance
 * panel. See `.ai/plans/active/support-tooling/README.md`.
 *
 * Reuses the conventions established by `organizations.spec.ts` /
 * `staff.spec.ts`: `fullyParallel: false, workers: 1` against the real dev
 * DB, a seeded `platform@agora.test` admin, a throwaway `test-<timestamp>`
 * org per test, and `owner@contoso.test` borrowed as a throwaway viewer
 * target (reverted to `platformRole: null` in `afterEach`, same as
 * `staff.spec.ts`).
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

async function signUpWorkspace(
  page: import("@playwright/test").Page,
  opts: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Workspace name").fill(opts.slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${opts.slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function signInStaff(
  page: import("@playwright/test").Page,
  host: string,
  email: string,
) {
  await page.goto(`http://${host}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

async function goToOrgDetail(
  adminPage: import("@playwright/test").Page,
  slug: string,
) {
  await adminPage.goto("http://localtest.me:3000/admin");
  await adminPage.waitForLoadState("networkidle");
  await adminPage.getByPlaceholder("Search organizations…").fill(slug);
  const row = adminPage.getByRole("row").filter({ hasText: slug });
  await row.getByRole("button", { name: "View" }).click();
  await adminPage.waitForURL(/\/admin\/organizations\/.+/);
}

/** Revert owner@contoso.test's platform role back to null, best-effort. */
async function revokeContosoRole(adminPage: import("@playwright/test").Page) {
  const res = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, {
    headers: { "x-platform-admin": "1" },
  });
  if (!res.ok()) return;
  const body = (await res.json()) as { items: { userId: string; email: string }[] };
  const contoso = body.items.find((i) => i.email === "owner@contoso.test");
  if (contoso) {
    await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${contoso.userId}/role`, {
      headers: { "x-platform-admin": "1" },
      data: { role: null },
    });
  }
}

test.describe("Platform Admin Support Tooling", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await revokeContosoRole(page);
    await ctx.close();
  });

  test("an admin links, updates, and clears a support ticket ref, and it persists on reload", async ({
    page,
  }) => {
    const uniq = Date.now();
    const slug = `test-support${uniq}`;
    const ownerEmail = `test-support-owner${uniq}@example.com`;

    await signUpWorkspace(page, { name: "Support Owner", email: ownerEmail, slug });

    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await goToOrgDetail(page, slug);

    await expect(page.getByText("No ticket linked.")).toBeVisible();
    await page.getByRole("button", { name: "Link ticket" }).click();
    await page.getByLabel("Ticket reference").fill("SUPP-1234");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("No ticket linked.")).toHaveCount(0);
    await expect(page.getByText("SUPP-1234")).toBeVisible();

    // Reload — the ref must persist.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("SUPP-1234")).toBeVisible();

    // Update to a different ref.
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Ticket reference").fill("SUPP-9999");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("SUPP-9999")).toBeVisible();
    await expect(page.getByText("SUPP-1234")).toHaveCount(0);

    // Clear it.
    await page.getByRole("button", { name: "Edit" }).click();
    await page.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByText("No ticket linked.")).toBeVisible();

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("No ticket linked.")).toBeVisible();

    // The activity panel now shows the support-ticket events for this org.
    await expect(page.getByText("organization.support_ticket_linked")).toBeVisible();
    await expect(page.getByText("organization.support_ticket_cleared")).toBeVisible();
  });

  test("a viewer sees the ticket ref read-only with no edit control, and a direct PATCH is rejected", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-support-viewer${uniq}`;
    const ownerEmail = `test-support-viewer-owner${uniq}@example.com`;

    const ownerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    await signUpWorkspace(ownerPage, {
      name: "Support Viewer Owner",
      email: ownerEmail,
      slug,
    });
    await ownerCtx.close();

    // Admin links a ticket ref and grants owner@contoso.test the viewer role.
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await goToOrgDetail(adminPage, slug);
    await adminPage.getByRole("button", { name: "Link ticket" }).click();
    await adminPage.getByLabel("Ticket reference").fill("SUPP-4242");
    await adminPage.getByRole("button", { name: "Save" }).click();
    await expect(adminPage.getByText("SUPP-4242")).toBeVisible();
    const orgId = adminPage.url().split("/organizations/")[1];

    const orgsRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations?search=contoso`,
      { headers: { "x-platform-admin": "1" } },
    );
    const orgsBody = (await orgsRes.json()) as { items: { id: string }[] };
    const contosoId = orgsBody.items[0]?.id;
    expect(contosoId).toBeTruthy();
    const membersRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${contosoId}/members`,
      { headers: { "x-platform-admin": "1" } },
    );
    const membersBody = (await membersRes.json()) as {
      items: { userId: string; email: string }[];
    };
    const contosoOwner = membersBody.items.find((m) => m.email === "owner@contoso.test");
    expect(contosoOwner).toBeTruthy();
    const grantRes = await adminPage.request.patch(
      `${API_URL}/rpc-admin/staff/${contosoOwner!.userId}/role`,
      { headers: { "x-platform-admin": "1" }, data: { role: "viewer" } },
    );
    expect(grantRes.ok()).toBeTruthy();

    // Sign in as the viewer and open the org detail page.
    await page.goto("http://localtest.me:3000/login");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill("owner@contoso.test");
    await page.getByLabel("Password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 15_000,
    });
    await page.goto(`http://localtest.me:3000/admin/organizations/${orgId}`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("SUPP-4242")).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Link ticket" })).toHaveCount(0);

    const directPatch = await page.request.patch(
      `${API_URL}/rpc-admin/organizations/${orgId}/support-ticket`,
      { headers: { "x-platform-admin": "1" }, data: { ticketRef: "SUPP-0000" } },
    );
    expect(directPatch.status()).toBe(403);

    await adminCtx.close();
  });

  test("the activity panel scopes events to this org and does not show another org's events", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slugA = `test-support-act-a${uniq}`;
    const slugB = `test-support-act-b${uniq}`;
    const ownerEmailA = `test-support-act-a-owner${uniq}@example.com`;
    const ownerEmailB = `test-support-act-b-owner${uniq}@example.com`;

    await signUpWorkspace(page, { name: "Org A Owner", email: ownerEmailA, slug: slugA });

    const bCtx = await browser.newContext();
    const bPage = await bCtx.newPage();
    await signUpWorkspace(bPage, { name: "Org B Owner", email: ownerEmailB, slug: slugB });
    await bCtx.close();

    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    // Link a ticket on org B only.
    await goToOrgDetail(adminPage, slugB);
    await adminPage.getByRole("button", { name: "Link ticket" }).click();
    await adminPage.getByLabel("Ticket reference").fill("SUPP-ORGB");
    await adminPage.getByRole("button", { name: "Save" }).click();
    await expect(adminPage.getByText("SUPP-ORGB")).toBeVisible();
    await expect(
      adminPage.getByText("organization.support_ticket_linked"),
    ).toBeVisible();

    // Org A's activity panel shows no support-ticket event at all.
    await goToOrgDetail(adminPage, slugA);
    await expect(adminPage.getByText("No recent activity.")).toBeVisible();
    await expect(
      adminPage.getByText("organization.support_ticket_linked"),
    ).toHaveCount(0);
    await expect(adminPage.getByText("SUPP-ORGB")).toHaveCount(0);

    await adminCtx.close();
  });
});
