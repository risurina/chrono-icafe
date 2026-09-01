import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the native platform support console (`/admin/support`,
 * `/admin/support/:id`) — spec #10. Distinct from `support-tooling.spec.ts`,
 * which covers the external `organization.supportTicketRef` link on the org
 * detail page; this drives the first-class ticket store.
 *
 * Reuses the conventions in `support-tooling.spec.ts` / `staff.spec.ts`:
 * `fullyParallel: false, workers: 1` against the real dev DB, the seeded
 * `platform@agora.test` admin, throwaway `test-<timestamp>` orgs, and
 * `owner@contoso.test` borrowed as a throwaway viewer target (reverted to
 * `platformRole: null` in `afterEach`).
 *
 * Tenant isolation note: `support_ticket` is platform-global (NOT RLS-scoped),
 * so the guarantee that the tables stay non-RLS is `rls:proof` + their absence
 * from `APP_TENANT_TABLES` — not an in-browser check. What this spec proves is
 * the org FILTER correctness: a ticket for org A never surfaces under an org B
 * filter, and vice-versa.
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

/** Resolve an org id by slug via the admin API. */
async function orgIdBySlug(
  adminPage: import("@playwright/test").Page,
  slug: string,
): Promise<string> {
  const res = await adminPage.request.get(
    `${API_URL}/rpc-admin/organizations?q=${slug}`,
    { headers: { "x-platform-admin": "1" } },
  );
  const body = (await res.json()) as { items: { id: string; slug: string }[] };
  const org = body.items.find((o) => o.slug === slug) ?? body.items[0];
  return org!.id;
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

test.describe("Platform Admin Support Tickets", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await revokeContosoRole(page);
    await ctx.close();
  });

  test("an admin creates, replies, notes, assigns, and resolves a ticket; each step persists on reload and the queue reflects it", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-tix${uniq}`;
    const ownerEmail = `test-tix-owner${uniq}@example.com`;

    const ownerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    await signUpWorkspace(ownerPage, { name: "Tix Owner", email: ownerEmail, slug });
    await ownerCtx.close();

    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/support");
    await page.waitForLoadState("networkidle");

    // Create a ticket via the "New ticket" dialog.
    const subject = `Export fails ${uniq}`;
    await page.getByRole("button", { name: "New ticket" }).click();
    await page.getByLabel("Tenant").click();
    await page.getByRole("option", { name: slug }).click();
    await page.getByLabel("Subject").fill(subject);
    await page.getByLabel("Opening message").fill("The CSV export button 500s.");
    await page.getByRole("button", { name: "Create ticket" }).click();

    // Lands on the detail page.
    await page.waitForURL(/\/admin\/support\/.+/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: subject })).toBeVisible();
    await expect(page.getByText("The CSV export button 500s.")).toBeVisible();

    // Reply + internal note; both render, the note flagged Internal.
    await page.getByLabel("Add reply").fill("Looking into it.");
    await page.getByRole("button", { name: "Send reply" }).click();
    await expect(page.getByText("Looking into it.")).toBeVisible();

    await page.getByLabel("Internal note").check();
    await page.getByLabel("Add internal note").fill("Worker OOM on staging.");
    await page.getByRole("button", { name: "Add note" }).click();
    await expect(page.getByText("Worker OOM on staging.")).toBeVisible();
    await expect(page.getByText("Internal")).toBeVisible();

    // Assign to the seeded platform admin.
    await page.getByLabel("Assigned to").click();
    await page.getByRole("option", { name: new RegExp(PLATFORM_ADMIN_EMAIL) }).click();
    await expect(page.getByText("Assignment updated.")).toBeVisible();

    // Resolve (confirm dialog).
    page.once("dialog", (d) => d.accept());
    await page.getByLabel("Status").click();
    await page.getByRole("option", { name: "resolved" }).click();
    await expect(page.getByText("Status updated.")).toBeVisible();

    // Persists on reload.
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("Looking into it.")).toBeVisible();
    await expect(page.getByText("Worker OOM on staging.")).toBeVisible();

    // The Resolved queue reflects the new status.
    await page.goto("http://localtest.me:3000/admin/support");
    await page.waitForLoadState("networkidle");
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Resolved" }).click();
    await expect(page.getByText(subject)).toBeVisible();
  });

  test("a viewer sees the queue/detail read-only and a direct POST/PATCH is rejected (403)", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-tix-viewer${uniq}`;
    const ownerEmail = `test-tix-viewer-owner${uniq}@example.com`;

    const ownerCtx = await browser.newContext();
    const ownerPage = await ownerCtx.newPage();
    await signUpWorkspace(ownerPage, { name: "Tix V Owner", email: ownerEmail, slug });
    await ownerCtx.close();

    // Admin creates a ticket and grants owner@contoso.test the viewer role.
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const orgId = await orgIdBySlug(adminPage, slug);
    const createRes = await adminPage.request.post(`${API_URL}/rpc-admin/support-tickets`, {
      headers: { "x-platform-admin": "1" },
      data: { organizationId: orgId, subject: `Viewer test ${uniq}`, body: "hello" },
    });
    expect(createRes.ok()).toBeTruthy();
    const ticket = (await createRes.json()) as { id: string };

    const contosoId = await orgIdBySlug(adminPage, "contoso");
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

    // Sign in as the viewer and open the ticket.
    await signInStaff(page, "localtest.me:3000", "owner@contoso.test");
    await page.goto(`http://localtest.me:3000/admin/support/${ticket.id}`);
    await page.waitForLoadState("networkidle");

    // Read-only: no New ticket, no controls, no composer.
    await expect(page.getByText(`Viewer test ${uniq}`)).toBeVisible();
    await expect(page.getByRole("button", { name: "Send reply" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add note" })).toHaveCount(0);
    await page.goto("http://localtest.me:3000/admin/support");
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "New ticket" })).toHaveCount(0);

    // Direct API mutations are refused.
    const directPost = await page.request.post(`${API_URL}/rpc-admin/support-tickets`, {
      headers: { "x-platform-admin": "1" },
      data: { organizationId: orgId, subject: "sneaky", body: "x" },
    });
    expect(directPost.status()).toBe(403);
    const directPatch = await page.request.patch(
      `${API_URL}/rpc-admin/support-tickets/${ticket.id}`,
      { headers: { "x-platform-admin": "1" }, data: { status: "closed" } },
    );
    expect(directPatch.status()).toBe(403);

    await adminCtx.close();
  });

  test("the queue org filter scopes to one tenant — org A's ticket never shows under org B's filter", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slugA = `test-tix-a${uniq}`;
    const slugB = `test-tix-b${uniq}`;

    const aCtx = await browser.newContext();
    const aPage = await aCtx.newPage();
    await signUpWorkspace(aPage, {
      name: "Tix A Owner",
      email: `test-tix-a-owner${uniq}@example.com`,
      slug: slugA,
    });
    await aCtx.close();

    const bCtx = await browser.newContext();
    const bPage = await bCtx.newPage();
    await signUpWorkspace(bPage, {
      name: "Tix B Owner",
      email: `test-tix-b-owner${uniq}@example.com`,
      slug: slugB,
    });
    await bCtx.close();

    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const orgAId = await orgIdBySlug(page, slugA);
    const orgBId = await orgIdBySlug(page, slugB);

    const subjectA = `A-only ${uniq}`;
    const subjectB = `B-only ${uniq}`;
    await page.request.post(`${API_URL}/rpc-admin/support-tickets`, {
      headers: { "x-platform-admin": "1" },
      data: { organizationId: orgAId, subject: subjectA, body: "a" },
    });
    await page.request.post(`${API_URL}/rpc-admin/support-tickets`, {
      headers: { "x-platform-admin": "1" },
      data: { organizationId: orgBId, subject: subjectB, body: "b" },
    });

    // Filter to org A (as the org-detail "View support tickets" link does).
    await page.goto(`http://localtest.me:3000/admin/support?organizationId=${orgAId}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(subjectA)).toBeVisible();
    await expect(page.getByText(subjectB)).toHaveCount(0);

    // Filter to org B — the inverse.
    await page.goto(`http://localtest.me:3000/admin/support?organizationId=${orgBId}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(subjectB)).toBeVisible();
    await expect(page.getByText(subjectA)).toHaveCount(0);
  });
});
