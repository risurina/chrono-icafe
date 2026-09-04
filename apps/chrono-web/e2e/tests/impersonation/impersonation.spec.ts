import { test, expect, type Page } from "@playwright/test";

/**
 * Browser coverage for the core impersonation lifecycle
 * (`/rpc-admin/impersonation/{start,stop}`, the org detail page's "Impersonate"
 * button, and the tenant dashboard banner): the happy path with its audit
 * trail, the platform `viewer` role gate, a non-platform-admin session's
 * rejection, the suspended-tenant refusal, and the "cannot impersonate a
 * platform-role holder" guard.
 *
 * Same conventions as `apps/web/e2e/tests/platform-admin/organizations.spec.ts`
 * and `staff.spec.ts`: real dev DB, `fullyParallel: false, workers: 1`
 * (`apps/web/playwright.config.ts`), throwaway `test-<timestamp>` orgs (never a
 * shared seeded org, since a suspended/mutated seeded org would poison later
 * specs), and `x-platform-admin: "1"` on every direct `/rpc-admin/*` call.
 *
 * See `apps/web/e2e/tests/impersonation/impersonation-scope.spec.ts` for what
 * an impersonated session can/cannot do, `impersonation-http-blocks.spec.ts`
 * for the `/api/auth/*` HTTP-surface blocks, and `impersonation-expiry.spec.ts`
 * for the hard-TTL single-fire audit test.
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
  await page.getByLabel("Business name").fill(opts.slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${opts.slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });
}

async function signInStaff(page: Page, host: string, email: string) {
  // Apex staff sign-in is /login; on a tenant host it is /admin/login.
  const loginPath = host === "localtest.me:3000" ? "/login" : "/admin/login";
  await page.goto(`http://${host}${loginPath}`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
    timeout: 15_000,
  });
}

/** Resolve an org's id via the admin org search, and its owner's userId. */
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
  expect(membersRes.ok()).toBeTruthy();
  const membersBody = (await membersRes.json()) as {
    items: { userId: string; email: string; role: string }[];
  };
  const owner = membersBody.items.find((m) => m.role === "owner");
  expect(owner).toBeTruthy();

  return { orgId: orgId!, ownerUserId: owner!.userId, ownerEmail: owner!.email };
}

async function findUserId(adminPage: Page, email: string): Promise<string> {
  const res = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, {
    headers: { "x-platform-admin": "1" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { userId: string; email: string }[] };
  const found = body.items.find((i) => i.email === email);
  expect(found).toBeTruthy();
  return found!.userId;
}

async function startImpersonation(adminPage: Page, targetUserId: string) {
  return adminPage.request.post(`${API_URL}/rpc-admin/impersonation/start`, {
    headers: { "x-platform-admin": "1" },
    data: { targetUserId },
  });
}

/** Best-effort: revert `email`'s platformRole to null. Mirrors staff.spec.ts. */
async function revokePlatformRole(adminPage: Page, email: string) {
  const res = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, {
    headers: { "x-platform-admin": "1" },
  });
  if (!res.ok()) return;
  const body = (await res.json()) as { items: { userId: string; email: string }[] };
  const found = body.items.find((i) => i.email === email);
  if (!found) return;
  await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${found.userId}/role`, {
    headers: { "x-platform-admin": "1" },
    data: { role: null },
  });
}

test.describe("Impersonation lifecycle", () => {
  test("platform admin impersonates a member, acts as them, stops, and both audit trails record it", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-imp-happy${uniq}`;
    const ownerEmail = `test-imp-happy-owner${uniq}@example.com`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUpWorkspace(page, { name: "Imp Owner", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const { orgId, ownerUserId } = await findOrgAndOwner(adminPage, slug);

    // Start impersonation from the org detail page (real UI path, not just the
    // API), so the "Impersonate" button + confirm dialog are exercised too.
    await adminPage.goto(`http://localtest.me:3000/admin/organizations/${orgId}`);
    await adminPage.waitForLoadState("networkidle");
    const row = adminPage.getByRole("row").filter({ hasText: ownerEmail });
    await row.getByRole("button", { name: "Impersonate" }).click();
    await adminPage.getByRole("dialog").getByRole("button", { name: "Impersonate" }).click();
    await adminPage.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
      timeout: 15_000,
    });

    // The banner is visible and non-dismissable; an allowed action works.
    await expect(adminPage.getByText(/you are impersonating/i)).toBeVisible();
    await adminPage.goto(`${base}/admin/settings/crew`);
    await adminPage.waitForLoadState("networkidle");
    await expect(adminPage.getByText(/you are impersonating/i)).toBeVisible();

    // Stop via the banner and land back on the org detail page.
    await adminPage.getByRole("button", { name: "Stop impersonating" }).click();
    await adminPage.waitForURL(new RegExp(`/admin/organizations/${orgId}`), {
      timeout: 15_000,
    });
    await expect(adminPage.getByText(/you are impersonating/i)).toHaveCount(0);

    // Platform-wide audit: both events recorded for this target.
    const auditRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/audit?q=impersonation&pageSize=100`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(auditRes.ok()).toBeTruthy();
    const auditBody = (await auditRes.json()) as {
      items: { action: string; targetId: string | null }[];
    };
    const started = auditBody.items.filter(
      (i) => i.action === "impersonation.started" && i.targetId === ownerUserId,
    );
    const ended = auditBody.items.filter(
      (i) => i.action === "impersonation.ended" && i.targetId === ownerUserId,
    );
    expect(started).toHaveLength(1);
    expect(ended).toHaveLength(1);

    // Tenant-scoped audit: `page` is still the real owner's session (signed up
    // at the top of this test) — confirm the matching `audit_event` rows exist.
    const tenantAudit = await page.evaluate(async (s) => {
      const api = location.origin.replace(/:3000$/, ":8787");
      const res = await fetch(`${api}/rpc/audit?pageSize=100`, {
        credentials: "include",
        headers: { "x-tenant-slug": s },
      });
      return { status: res.status, body: res.ok ? await res.json() : null };
    }, slug);
    expect(tenantAudit.status).toBe(200);
    const tenantItems = (tenantAudit.body as { items: { action: string }[] }).items;
    expect(tenantItems.some((i) => i.action === "impersonation.started")).toBe(true);
    expect(tenantItems.some((i) => i.action === "impersonation.ended")).toBe(true);

    await adminContext.close();
  });

  test("a platform viewer gets 403 starting impersonation, and the UI never renders the button", async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    // Borrow the seeded contoso owner as a throwaway viewer, same pattern as
    // staff.spec.ts, reverted in this test's own cleanup below. `/rpc-admin/staff`
    // only lists users who already hold a platform role, so resolve the id via
    // org membership (same helper other specs use), not `findUserId`.
    const { ownerUserId: contosoOwnerId } = await findOrgAndOwner(adminPage, "contoso");
    const grant = await adminPage.request.patch(
      `${API_URL}/rpc-admin/staff/${contosoOwnerId}/role`,
      { headers: { "x-platform-admin": "1" }, data: { role: "viewer" } },
    );
    expect(grant.ok()).toBeTruthy();

    try {
      const { orgId: acmeOrgId } = await (async () => {
        const res = await adminPage.request.get(
          `${API_URL}/rpc-admin/organizations?search=acme`,
          { headers: { "x-platform-admin": "1" } },
        );
        const body = (await res.json()) as { items: { id: string }[] };
        return { orgId: body.items[0]!.id };
      })();

      const viewerContext = await browser.newContext();
      const viewerPage = await viewerContext.newPage();
      await signInStaff(viewerPage, "localtest.me:3000", "owner@contoso.test");

      // Visibility: the org detail page never renders "Impersonate" for a
      // viewer (permissions:read only, no impersonation:start).
      await viewerPage.goto(`http://localtest.me:3000/admin/organizations/${acmeOrgId}`);
      await viewerPage.waitForLoadState("networkidle");
      await expect(viewerPage.getByRole("button", { name: "Impersonate" })).toHaveCount(0);

      // The real gate: a direct call still 403s. `owner@acme.test` holds no
      // platform role, so resolve their id via org membership, not
      // `/rpc-admin/staff` (which only lists existing platform-role holders).
      const { ownerUserId: acmeOwnerId } = await findOrgAndOwner(viewerPage, "acme");
      const startRes = await startImpersonation(viewerPage, acmeOwnerId);
      expect(startRes.status()).toBe(403);

      await viewerContext.close();
    } finally {
      await revokePlatformRole(adminPage, "owner@contoso.test");
      await adminContext.close();
    }
  });

  test("a tenant session with no platform role cannot call the impersonation route", async ({
    page,
  }) => {
    await signInStaff(page, "acme.localtest.me:3000", "owner@acme.test");
    await page.waitForURL(/\/admin/, { timeout: 30_000 });

    const res = await page.request.post(
      `${API_URL}/rpc-admin/impersonation/start`,
      { headers: { "x-platform-admin": "1" }, data: { targetUserId: "irrelevant" } },
    );
    expect(res.status()).toBe(403);
  });

  test("starting impersonation into a suspended tenant's member is refused", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-imp-suspended${uniq}`;
    const ownerEmail = `test-imp-suspended-owner${uniq}@example.com`;

    await signUpWorkspace(page, { name: "Imp Owner", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { orgId, ownerUserId } = await findOrgAndOwner(adminPage, slug);

    const suspendRes = await adminPage.request.post(
      `${API_URL}/rpc-admin/organizations/${orgId}/suspend`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(suspendRes.ok()).toBeTruthy();

    try {
      const startRes = await startImpersonation(adminPage, ownerUserId);
      expect(startRes.status()).toBe(400);
    } finally {
      await adminPage.request.post(
        `${API_URL}/rpc-admin/organizations/${orgId}/resume`,
        { headers: { "x-platform-admin": "1" } },
      );
      await adminContext.close();
    }
  });

  test("cannot start impersonation targeting another platform-role holder", async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    // The seeded platform admin itself holds a platformRole — an invalid
    // impersonation target regardless of who is attempting it.
    const platformAdminUserId = await findUserId(adminPage, PLATFORM_ADMIN_EMAIL);
    const res = await startImpersonation(adminPage, platformAdminUserId);
    expect(res.status()).toBe(400);

    await adminContext.close();
  });
});
