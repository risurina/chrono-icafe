import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the platform admin feature-flag surface:
 * `GET`/`PUT /rpc-admin/organizations/:id/feature-flags`, surfaced on
 * `/admin/organizations/[id]`'s "Feature flags" card. Covers the happy path
 * (admin toggles a flag, the tenant's own Features page reflects the same
 * effective state), the role gate (a platform viewer sees no toggle control
 * and a direct PUT is rejected), cross-tenant isolation (toggling org A never
 * touches org B), the audit trail, and the CSRF-preflight header guard.
 *
 * Two throwaway `test-<timestamp>` orgs are used (never a shared seeded org
 * like acme/contoso) — this suite runs `fullyParallel: false, workers: 1`
 * against the real dev DB, same conventions as `organizations.spec.ts`.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const FLAG_KEY = "example.beta_dashboard";
const FLAG_LABEL = "Beta dashboard";

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
  await page.getByLabel("Business name").fill(opts.slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${opts.slug}\\.localtest\\.me:3000/admin`), {
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
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
    timeout: 15_000,
  });
}

async function findOrgId(
  page: import("@playwright/test").Page,
  slug: string,
): Promise<string> {
  const res = await page.request.get(
    `${API_URL}/rpc-admin/organizations?q=${slug}`,
    { headers: { "x-platform-admin": "1" } },
  );
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string }[] };
  const id = body.items[0]?.id;
  expect(id).toBeTruthy();
  return id!;
}

/** Best-effort cleanup: revert a seeded account's platform role to null. */
async function revokeRole(adminPage: import("@playwright/test").Page, email: string) {
  const res = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, {
    headers: { "x-platform-admin": "1" },
  });
  if (!res.ok()) return;
  const body = (await res.json()) as { items: { userId: string; email: string }[] };
  const target = body.items.find((i) => i.email === email);
  if (!target) return;
  await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${target.userId}/role`, {
    headers: { "x-platform-admin": "1" },
    data: { role: null },
  });
}

test.describe("Platform Admin — Feature Flags", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await revokeRole(page, "owner@acme.test");
    await ctx.close();
  });

  test("platform admin toggles a flag; the tenant's own Features page reflects it; org B is unaffected; the toggle is audited", async ({
    page,
    browser,
  }) => {
    // Two business sign-ups plus several full navigations exceed the default
    // 90s budget on a cold dev-server compile (first test to hit these routes).
    test.setTimeout(180_000);
    const uniq = Date.now();
    const slugA = `test-ff-a${uniq}`;
    const slugB = `test-ff-b${uniq}`;
    const ownerAEmail = `test-ff-owner-a${uniq}@example.com`;
    const ownerBEmail = `test-ff-owner-b${uniq}@example.com`;

    // Two throwaway orgs — the second proves isolation.
    await signUpWorkspace(page, { name: "FF Owner A", email: ownerAEmail, slug: slugA });
    const ownerBContext = await browser.newContext();
    const ownerBPage = await ownerBContext.newPage();
    await signUpWorkspace(ownerBPage, {
      name: "FF Owner B",
      email: ownerBEmail,
      slug: slugB,
    });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const orgAId = await findOrgId(adminPage, slugA);
    const orgBId = await findOrgId(adminPage, slugB);

    // Both orgs start at the registry default (disabled) for this flag.
    await adminPage.goto(`http://localtest.me:3000/admin/organizations/${orgAId}`);
    await adminPage.waitForLoadState("networkidle");
    const toggle = adminPage.getByRole("switch", { name: `Toggle ${FLAG_LABEL}` });
    await expect(toggle).not.toBeChecked();

    // Toggle it on via the UI.
    await toggle.click();
    await expect(toggle).toBeChecked();

    // Reload to confirm the write persisted server-side, not just optimistic UI.
    await adminPage.reload();
    await adminPage.waitForLoadState("networkidle");
    await expect(
      adminPage.getByRole("switch", { name: `Toggle ${FLAG_LABEL}` }),
    ).toBeChecked();

    // The tenant's own Features page shows the identical effective state.
    await page.goto(`http://${slugA}.localtest.me:3000/admin/settings/features`);
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByRole("switch", { name: `Toggle ${FLAG_LABEL}` }),
    ).toBeChecked();

    // Cross-tenant isolation: org B's flags are unaffected, via both the
    // admin API and org B's own dashboard.
    const orgBDetailRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${orgBId}`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(orgBDetailRes.ok()).toBeTruthy();
    const orgBDetail = (await orgBDetailRes.json()) as {
      featureFlags: { key: string; enabled: boolean }[];
    };
    expect(orgBDetail.featureFlags.find((f) => f.key === FLAG_KEY)?.enabled).toBe(false);

    await ownerBPage.goto(
      `http://${slugB}.localtest.me:3000/admin/settings/features`,
    );
    await ownerBPage.waitForLoadState("networkidle");
    await expect(
      ownerBPage.getByRole("switch", { name: `Toggle ${FLAG_LABEL}` }),
    ).not.toBeChecked();

    // Audit trail: one platform.featureFlag.toggled row for org A with the
    // expected shape.
    const auditRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/audit?q=platform.featureFlag.toggled`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(auditRes.ok()).toBeTruthy();
    const auditBody = (await auditRes.json()) as {
      items: {
        action: string;
        targetType: string;
        targetId: string;
        targetLabel: string | null;
        metadata: { key?: string; enabled?: boolean; previousEnabled?: boolean } | null;
      }[];
    };
    const row = auditBody.items.find((i) => i.targetId === orgAId);
    expect(row).toBeTruthy();
    expect(row!.targetType).toBe("tenant");
    expect(row!.targetLabel).toBe(slugA);
    expect(row!.metadata).toMatchObject({
      key: FLAG_KEY,
      enabled: true,
      previousEnabled: false,
    });

    await ownerBContext.close();
    await adminContext.close();
  });

  test("a platform viewer sees no toggle control, and a direct PUT is rejected (403)", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-ff-viewer${uniq}`;
    const ownerEmail = `test-ff-viewer-owner${uniq}@example.com`;
    await signUpWorkspace(page, { name: "FF Viewer Org", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const orgId = await findOrgId(adminPage, slug);

    // Grant owner@acme.test the "viewer" platform role, borrowed as a
    // throwaway platform-role target (see staff.spec.ts's exact pattern);
    // reverted in afterEach. Resolve their userId via a search against acme,
    // independent of the throwaway org this test is exercising.
    const acmeOrgRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations?q=acme`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(acmeOrgRes.ok()).toBeTruthy();
    const acmeOrgBody = (await acmeOrgRes.json()) as { items: { id: string }[] };
    const acmeId = acmeOrgBody.items[0]?.id;
    expect(acmeId).toBeTruthy();
    const acmeMembersRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${acmeId}/members`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(acmeMembersRes.ok()).toBeTruthy();
    const acmeMembersBody = (await acmeMembersRes.json()) as {
      items: { userId: string; email: string }[];
    };
    const acmeOwner = acmeMembersBody.items.find((m) => m.email === "owner@acme.test");
    expect(acmeOwner).toBeTruthy();

    const grantRes = await adminPage.request.patch(
      `${API_URL}/rpc-admin/staff/${acmeOwner!.userId}/role`,
      { headers: { "x-platform-admin": "1" }, data: { role: "viewer" } },
    );
    expect(grantRes.ok()).toBeTruthy();

    // Sign in as the newly-granted viewer and check the org detail page.
    await page.goto("http://localtest.me:3000/login");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill("owner@acme.test");
    await page.getByLabel("Password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
      timeout: 15_000,
    });
    await page.goto(`http://localtest.me:3000/admin/organizations/${orgId}`);
    await page.waitForLoadState("networkidle");
    // No interactive control — the viewer sees the read-only Badge fallback.
    await expect(
      page.getByRole("switch", { name: `Toggle ${FLAG_LABEL}` }),
    ).toHaveCount(0);
    await expect(page.getByText("Disabled").first()).toBeVisible();

    // The client-side hiding is not a security boundary — the direct PUT
    // must also be rejected.
    const directPut = await page.request.put(
      `${API_URL}/rpc-admin/organizations/${orgId}/feature-flags`,
      {
        headers: { "x-platform-admin": "1" },
        data: { key: FLAG_KEY, enabled: true },
      },
    );
    expect(directPut.status()).toBe(403);

    await adminContext.close();
  });

  test("a PUT without the x-platform-admin CSRF-preflight header is rejected (400)", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-ff-header${uniq}`;
    const ownerEmail = `test-ff-header-owner${uniq}@example.com`;
    await signUpWorkspace(page, { name: "FF Header Org", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const orgId = await findOrgId(adminPage, slug);

    const res = await adminPage.request.put(
      `${API_URL}/rpc-admin/organizations/${orgId}/feature-flags`,
      { data: { key: FLAG_KEY, enabled: true } },
    );
    expect(res.status()).toBe(400);

    await adminContext.close();
  });
});
