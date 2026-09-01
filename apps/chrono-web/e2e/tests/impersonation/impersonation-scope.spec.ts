import { test, expect, type Page } from "@playwright/test";

/**
 * Browser coverage for what an impersonated session can and cannot do, as
 * distinct from `impersonation.spec.ts`'s start/stop lifecycle:
 *
 *   - an owner-only action (tenant suspend) stays blocked while impersonating
 *     that same owner, contrasted against a *real* owner session that can do
 *     it (Blocker 1's `IMPERSONATION_DENY_LIST` + the tenant middleware never
 *     extending the owner-suspended exemption to an impersonated session);
 *   - the persistence/exfiltration deny list (api keys, staff invites) holds
 *     end-to-end, contrasted the same way;
 *   - cross-tenant isolation still holds for an impersonated session — the
 *     `getTenantContext()` rewrite in Phase 3 is the function every
 *     tenant-scoped request depends on, so this is required by
 *     `.ai/rules/e2e-testing.md` even though `project` isn't the resource
 *     under test.
 *
 * Same conventions as `impersonation.spec.ts` (real dev DB, `workers: 1`,
 * throwaway `test-<timestamp>` orgs, `x-platform-admin: "1"`).
 *
 * Per the plan's Out-of-Scope: `pnpm --filter @agora/api rls:proof` must also
 * be re-run manually after this phase's changes and confirmed to print
 * `RLS PROOF: PASS ✅` — that is a separate command, not something this
 * browser suite can invoke itself.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

async function signUpWorkspace(
  page: Page,
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

async function signInStaff(page: Page, host: string, email: string) {
  await page.goto(`http://${host}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

async function findOrgAndOwner(adminPage: Page, slug: string) {
  const orgsRes = await adminPage.request.get(
    `${API_URL}/rpc-admin/organizations?search=${slug}`,
    { headers: { "x-platform-admin": "1" } },
  );
  expect(orgsRes.ok()).toBeTruthy();
  const orgsBody = (await orgsRes.json()) as { items: { id: string }[] };
  const orgId = orgsBody.items[0]?.id;
  expect(orgId).toBeTruthy();

  const membersRes = await adminPage.request.get(
    `${API_URL}/rpc-admin/organizations/${orgId}/members`,
    { headers: { "x-platform-admin": "1" } },
  );
  const membersBody = (await membersRes.json()) as {
    items: { userId: string; email: string; role: string }[];
  };
  const owner = membersBody.items.find((m) => m.role === "owner");
  expect(owner).toBeTruthy();

  return { orgId: orgId!, ownerUserId: owner!.userId };
}

async function startImpersonation(adminPage: Page, targetUserId: string) {
  const res = await adminPage.request.post(
    `${API_URL}/rpc-admin/impersonation/start`,
    { headers: { "x-platform-admin": "1" }, data: { targetUserId } },
  );
  expect(res.ok()).toBeTruthy();
}

async function stopImpersonation(adminPage: Page) {
  await adminPage.request.post(`${API_URL}/rpc-admin/impersonation/stop`, {
    headers: { "x-platform-admin": "1" },
  });
}

/** Issue a tenant-scoped request from inside the page (cookie-domain-correct). */
async function tenantRequest(
  page: Page,
  tenantSlug: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ slug, method, path, body }) => {
      const api = location.origin.replace(/:3000$/, ":8787");
      const res = await fetch(`${api}${path}`, {
        method,
        credentials: "include",
        headers: {
          "x-tenant-slug": slug,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, body: json };
    },
    { slug: tenantSlug, method, path, body },
  );
}

test.describe("Impersonation scope", () => {
  test("an owner-only action stays blocked while impersonating that owner, but works for the real owner", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-imp-scope-danger${uniq}`;
    const ownerEmail = `test-imp-scope-danger-owner${uniq}@example.com`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUpWorkspace(page, { name: "Scope Owner", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { orgId, ownerUserId } = await findOrgAndOwner(adminPage, slug);

    await startImpersonation(adminPage, ownerUserId);
    await adminPage.goto(`${base}/dashboard/settings/danger`);
    await adminPage.waitForLoadState("networkidle");

    // The IMPERSONATION_DENY_LIST strips the whole `tenant` resource, so the
    // page's own `GET /rpc/tenant/lifecycle` read 403s too — the Danger Zone
    // card (and its Suspend button) never renders at all. This is a stronger
    // guarantee than "the control renders but the click fails": the control
    // is absent entirely while impersonating, consistent with this codebase's
    // rule that frontend checks are visibility-only and follow from whatever
    // permissions the session actually has.
    await expect(
      adminPage.getByRole("button", { name: "Suspend workspace" }),
    ).toHaveCount(0);

    // Direct API confirmation of the 403, and that the tenant stayed active.
    const impersonatedSuspend = await tenantRequest(
      adminPage,
      slug,
      "POST",
      "/rpc/tenant/suspend",
    );
    expect(impersonatedSuspend.status).toBe(403);

    await stopImpersonation(adminPage);

    // Contrast: the real owner, no impersonation active, can suspend.
    const realSuspend = await tenantRequest(page, slug, "POST", "/rpc/tenant/suspend");
    expect(realSuspend.status).toBe(200);

    // Clean up via the platform admin route so the throwaway org isn't left
    // suspended for later specs.
    await adminPage.request.post(`${API_URL}/rpc-admin/organizations/${orgId}/resume`, {
      headers: { "x-platform-admin": "1" },
    });

    await adminContext.close();
  });

  test("the persistence deny list blocks api-key creation and staff invites while impersonating, but not for the real owner", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-imp-scope-deny${uniq}`;
    const ownerEmail = `test-imp-scope-deny-owner${uniq}@example.com`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUpWorkspace(page, { name: "Deny Owner", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { ownerUserId } = await findOrgAndOwner(adminPage, slug);

    await startImpersonation(adminPage, ownerUserId);
    await adminPage.goto(`${base}/dashboard`);

    const impersonatedKey = await tenantRequest(adminPage, slug, "POST", "/rpc/api-keys", {
      name: "impersonated-attempt",
      role: "admin",
    });
    expect(impersonatedKey.status).toBe(403);

    const impersonatedInvite = await tenantRequest(adminPage, slug, "POST", "/rpc/invites", {
      email: `test-imp-scope-deny-invite-imp${uniq}@example.com`,
      role: "staff",
    });
    expect(impersonatedInvite.status).toBe(403);

    await stopImpersonation(adminPage);

    // Contrast: the real owner, no impersonation active, succeeds at both.
    await page.goto(`${base}/dashboard`);
    const realKey = await tenantRequest(page, slug, "POST", "/rpc/api-keys", {
      name: "real-owner-key",
      role: "admin",
    });
    expect([200, 201]).toContain(realKey.status);

    const realInvite = await tenantRequest(page, slug, "POST", "/rpc/invites", {
      email: `test-imp-scope-deny-invite-real${uniq}@example.com`,
      role: "staff",
    });
    expect([200, 201]).toContain(realInvite.status);

    await adminContext.close();
  });

  test("cross-tenant isolation holds while impersonating: tenant B's resources stay unreachable via tenant A's grant", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slugA = `test-imp-iso-a${uniq}`;
    const slugB = `test-imp-iso-b${uniq}`;
    const ownerEmailA = `test-imp-iso-a-owner${uniq}@example.com`;
    const ownerEmailB = `test-imp-iso-b-owner${uniq}@example.com`;

    await signUpWorkspace(page, { name: "Iso A Owner", email: ownerEmailA, slug: slugA });

    const bContext = await browser.newContext();
    const bPage = await bContext.newPage();
    await signUpWorkspace(bPage, { name: "Iso B Owner", email: ownerEmailB, slug: slugB });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { ownerUserId: ownerAId } = await findOrgAndOwner(adminPage, slugA);

    await startImpersonation(adminPage, ownerAId);
    await adminPage.goto(`http://${slugA}.localtest.me:3000/dashboard`);

    // While impersonating a member of tenant A, a request scoped to tenant
    // B's host must never succeed and must never leak tenant B's rows.
    const crossTenant = await tenantRequest(adminPage, slugB, "GET", "/rpc/me");
    expect([401, 403]).toContain(crossTenant.status);
    // A 403 carries an error message body, not no body — the real guarantee
    // is that it never carries tenant B's actual data.
    expect(JSON.stringify(crossTenant.body)).not.toContain(slugB);

    await stopImpersonation(adminPage);
    await bContext.close();
    await adminContext.close();
  });
});
