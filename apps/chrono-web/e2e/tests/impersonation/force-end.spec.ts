import { test, expect, type Page } from "@playwright/test";

/**
 * Browser coverage for force-ending another admin's stuck/abandoned
 * impersonation grant (`/rpc-admin/impersonation/active`,
 * `/rpc-admin/impersonation/:grantId/force-end`), the `/admin/impersonations`
 * page, and the restore path the extended `/impersonation/stop` handler
 * gains (`packages/agora/src/platform-admin/routes.ts`) — see
 * `.ai/plans/agora/active/impersonation-force-end/README.md`.
 *
 * Same conventions as `impersonation.spec.ts`: real dev DB,
 * `fullyParallel: false, workers: 1` (`apps/web/playwright.config.ts`),
 * throwaway `test-<timestamp>` orgs, and `x-platform-admin: "1"` on every
 * direct `/rpc-admin/*` call. A second platform admin is obtained by
 * temporarily promoting a borrowed seeded tenant owner (same pattern as
 * `impersonation.spec.ts`'s viewer-role test), reverted in each test's
 * `finally`.
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
  expect(membersRes.ok()).toBeTruthy();
  const membersBody = (await membersRes.json()) as {
    items: { userId: string; email: string; role: string }[];
  };
  const owner = membersBody.items.find((m) => m.role === "owner");
  expect(owner).toBeTruthy();
  return { orgId: orgId!, ownerUserId: owner!.userId, ownerEmail: owner!.email };
}

async function startImpersonation(adminPage: Page, targetUserId: string) {
  return adminPage.request.post(`${API_URL}/rpc-admin/impersonation/start`, {
    headers: { "x-platform-admin": "1" },
    data: { targetUserId },
  });
}

async function grantPlatformRole(
  adminPage: Page,
  targetUserId: string,
  role: "viewer" | "admin" | null,
) {
  return adminPage.request.patch(`${API_URL}/rpc-admin/staff/${targetUserId}/role`, {
    headers: { "x-platform-admin": "1" },
    data: { role },
  });
}

/** Best-effort: revert `email`'s platformRole to null. Mirrors impersonation.spec.ts. */
async function revokePlatformRole(adminPage: Page, email: string) {
  const res = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, {
    headers: { "x-platform-admin": "1" },
  });
  if (!res.ok()) return;
  const body = (await res.json()) as { items: { userId: string; email: string }[] };
  const found = body.items.find((i) => i.email === email);
  if (!found) return;
  await grantPlatformRole(adminPage, found.userId, null);
}

async function listActiveGrants(page: Page) {
  const res = await page.request.get(`${API_URL}/rpc-admin/impersonation/active`, {
    headers: { "x-platform-admin": "1" },
  });
  return res;
}

async function forceEnd(page: Page, grantId: string) {
  return page.request.post(
    `${API_URL}/rpc-admin/impersonation/${grantId}/force-end`,
    { headers: { "x-platform-admin": "1" } },
  );
}

test.describe("Impersonation force-end", () => {
  test("admin B force-ends admin A's grant; both audit trails record both identities; admin A recovers", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-imp-fe-happy${uniq}`;
    const ownerEmail = `test-imp-fe-happy-owner${uniq}@example.com`;

    await signUpWorkspace(page, { name: "FE Owner", email: ownerEmail, slug });

    // Admin A: the seeded platform admin, starts an impersonation session.
    const adminAContext = await browser.newContext();
    const adminAPage = await adminAContext.newPage();
    await signInStaff(adminAPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { ownerUserId } = await findOrgAndOwner(adminAPage, slug);
    const startRes = await startImpersonation(adminAPage, ownerUserId);
    expect(startRes.ok()).toBeTruthy();
    const { grantId } = (await startRes.json()) as { grantId: string };

    // Admin B: a second, independent platform admin (borrowed contoso owner,
    // promoted for this test only).
    const adminBContext = await browser.newContext();
    const adminBPage = await adminBContext.newPage();
    await signInStaff(adminBPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { ownerUserId: contosoOwnerId, ownerEmail: contosoOwnerEmail } =
      await findOrgAndOwner(adminBPage, "contoso");
    const grant = await grantPlatformRole(adminBPage, contosoOwnerId, "admin");
    expect(grant.ok()).toBeTruthy();

    try {
      await signInStaff(adminBPage, "localtest.me:3000", contosoOwnerEmail);

      // The grant shows up in the active list.
      const activeRes = await listActiveGrants(adminBPage);
      expect(activeRes.ok()).toBeTruthy();
      const activeBody = (await activeRes.json()) as {
        items: { grantId: string; targetUserId: string }[];
      };
      expect(activeBody.items.some((i) => i.grantId === grantId)).toBe(true);

      // Force-end via the real admin page.
      await adminBPage.goto("http://localtest.me:3000/admin/impersonations");
      await adminBPage.waitForLoadState("networkidle");
      const row = adminBPage.getByRole("row").filter({ hasText: ownerEmail });
      await row.getByRole("button", { name: "Force end" }).click();
      await adminBPage
        .getByRole("dialog")
        .getByRole("button", { name: "Force end" })
        .click();
      await expect(adminBPage.getByText(ownerEmail)).toHaveCount(0);

      // Both audit trails carry both admin identities.
      const auditRes = await adminBPage.request.get(
        `${API_URL}/rpc-admin/audit?q=impersonation.force-ended&pageSize=100`,
        { headers: { "x-platform-admin": "1" } },
      );
      expect(auditRes.ok()).toBeTruthy();
      const auditBody = (await auditRes.json()) as {
        items: {
          action: string;
          targetId: string | null;
          actorLabel: string;
          metadata: { startedByAdminLabel?: string; grantId?: string } | null;
        }[];
      };
      const forceEnded = auditBody.items.filter(
        (i) => i.action === "impersonation.force-ended" && i.targetId === ownerUserId,
      );
      expect(forceEnded).toHaveLength(1);
      expect(forceEnded[0]!.actorLabel).toBe(contosoOwnerEmail);
      expect(forceEnded[0]!.metadata?.startedByAdminLabel).toBe(PLATFORM_ADMIN_EMAIL);

      const tenantAudit = await page.evaluate(
        async ({ s, api }) => {
          const res = await fetch(`${api}/rpc/audit?pageSize=100`, {
            credentials: "include",
            headers: { "x-tenant-slug": s },
          });
          return { status: res.status, body: res.ok ? await res.json() : null };
        },
        { s: slug, api: API_URL },
      );
      expect(tenantAudit.status).toBe(200);
      const tenantItems = (tenantAudit.body as { items: { action: string }[] }).items;
      expect(tenantItems.some((i) => i.action === "impersonation.force-ended")).toBe(
        true,
      );

      // Admin A's next dashboard poll 401s, and the banner's restore action
      // recovers their own session (Phase 5 restore path).
      await adminAPage.goto(`http://${slug}.localtest.me:3000/dashboard`);
      const meRes = await adminAPage.request.get(`${API_URL}/rpc/me`, {
        headers: { "x-tenant-slug": slug },
      });
      expect(meRes.status()).toBe(401);

      const stopRes = await adminAPage.request.post(
        `${API_URL}/rpc-admin/impersonation/stop`,
        { headers: { "x-platform-admin": "1" } },
      );
      expect(stopRes.ok()).toBeTruthy();

      // The restored session is a real, usable platform-admin session again.
      const restoredMe = await adminAPage.request.get(`${API_URL}/rpc-admin/me`, {
        headers: { "x-platform-admin": "1" },
      });
      expect(restoredMe.ok()).toBeTruthy();
      const restoredBody = (await restoredMe.json()) as { platformRole: string | null };
      expect(restoredBody.platformRole).toBeTruthy();
    } finally {
      await revokePlatformRole(adminBPage, contosoOwnerEmail);
      await adminAContext.close();
      await adminBContext.close();
    }
  });

  test("a platform viewer gets 403 force-ending, and the nav entry/button are hidden", async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const { ownerUserId: contosoOwnerId, ownerEmail: contosoOwnerEmail } =
      await findOrgAndOwner(adminPage, "contoso");
    const grant = await grantPlatformRole(adminPage, contosoOwnerId, "viewer");
    expect(grant.ok()).toBeTruthy();

    try {
      const viewerContext = await browser.newContext();
      const viewerPage = await viewerContext.newPage();
      await signInStaff(viewerPage, "localtest.me:3000", contosoOwnerEmail);

      // Nav entry hidden.
      await viewerPage.goto("http://localtest.me:3000/admin");
      await viewerPage.waitForLoadState("networkidle");
      await expect(
        viewerPage.getByRole("link", { name: "Impersonations" }),
      ).toHaveCount(0);

      // The real gate: a direct call 403s for both routes.
      const listRes = await listActiveGrants(viewerPage);
      expect(listRes.status()).toBe(403);
      const forceEndRes = await forceEnd(viewerPage, "irrelevant-grant-id");
      expect(forceEndRes.status()).toBe(403);

      await viewerContext.close();
    } finally {
      await revokePlatformRole(adminPage, contosoOwnerEmail);
      await adminContext.close();
    }
  });

  test("an admin cannot force-end their own grant", async ({ page, browser }) => {
    const uniq = Date.now();
    const slug = `test-imp-fe-self${uniq}`;
    const ownerEmail = `test-imp-fe-self-owner${uniq}@example.com`;

    await signUpWorkspace(page, { name: "FE Self Owner", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { ownerUserId } = await findOrgAndOwner(adminPage, slug);
    const startRes = await startImpersonation(adminPage, ownerUserId);
    expect(startRes.ok()).toBeTruthy();
    const { grantId } = (await startRes.json()) as { grantId: string };

    // `startImpersonation` swapped adminPage's own session to the target's —
    // force-end from a SEPARATE, still-admin session for the same admin.
    const selfContext = await browser.newContext();
    const selfPage = await selfContext.newPage();
    await signInStaff(selfPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const res = await forceEnd(selfPage, grantId);
    expect(res.status()).toBe(400);

    await adminContext.close();
    await selfContext.close();
  });

  test("force-ending an already-ended grant returns non-200 and does not double-write audit rows", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-imp-fe-race${uniq}`;
    const ownerEmail = `test-imp-fe-race-owner${uniq}@example.com`;

    await signUpWorkspace(page, { name: "FE Race Owner", email: ownerEmail, slug });

    const adminAContext = await browser.newContext();
    const adminAPage = await adminAContext.newPage();
    await signInStaff(adminAPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { ownerUserId } = await findOrgAndOwner(adminAPage, slug);
    const startRes = await startImpersonation(adminAPage, ownerUserId);
    expect(startRes.ok()).toBeTruthy();
    const { grantId } = (await startRes.json()) as { grantId: string };

    const adminBContext = await browser.newContext();
    const adminBPage = await adminBContext.newPage();
    await signInStaff(adminBPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { ownerUserId: contosoOwnerId, ownerEmail: contosoOwnerEmail } =
      await findOrgAndOwner(adminBPage, "contoso");
    const grant = await grantPlatformRole(adminBPage, contosoOwnerId, "admin");
    expect(grant.ok()).toBeTruthy();

    try {
      await signInStaff(adminBPage, "localtest.me:3000", contosoOwnerEmail);

      const first = await forceEnd(adminBPage, grantId);
      expect(first.ok()).toBeTruthy();

      const auditBefore = await adminBPage.request.get(
        `${API_URL}/rpc-admin/audit?q=impersonation.force-ended&pageSize=100`,
        { headers: { "x-platform-admin": "1" } },
      );
      const bodyBefore = (await auditBefore.json()) as {
        items: { targetId: string | null }[];
      };
      const countBefore = bodyBefore.items.filter(
        (i) => i.targetId === ownerUserId,
      ).length;
      expect(countBefore).toBe(1);

      // Second attempt on the same already-closed grant: non-200, no second
      // audit row.
      const second = await forceEnd(adminBPage, grantId);
      expect(second.ok()).toBeFalsy();
      expect([404, 409]).toContain(second.status());

      const auditAfter = await adminBPage.request.get(
        `${API_URL}/rpc-admin/audit?q=impersonation.force-ended&pageSize=100`,
        { headers: { "x-platform-admin": "1" } },
      );
      const bodyAfter = (await auditAfter.json()) as {
        items: { targetId: string | null }[];
      };
      const countAfter = bodyAfter.items.filter((i) => i.targetId === ownerUserId).length;
      expect(countAfter).toBe(1);
    } finally {
      await revokePlatformRole(adminBPage, contosoOwnerEmail);
      await adminAContext.close();
      await adminBContext.close();
    }
  });

  test("restore-path regression: the restored session cookie is accepted by a follow-up authenticated request", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-imp-fe-restore${uniq}`;
    const ownerEmail = `test-imp-fe-restore-owner${uniq}@example.com`;

    await signUpWorkspace(page, { name: "FE Restore Owner", email: ownerEmail, slug });

    const adminAContext = await browser.newContext();
    const adminAPage = await adminAContext.newPage();
    await signInStaff(adminAPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { ownerUserId } = await findOrgAndOwner(adminAPage, slug);
    const startRes = await startImpersonation(adminAPage, ownerUserId);
    expect(startRes.ok()).toBeTruthy();
    const { grantId } = (await startRes.json()) as { grantId: string };

    const adminBContext = await browser.newContext();
    const adminBPage = await adminBContext.newPage();
    await signInStaff(adminBPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { ownerUserId: contosoOwnerId, ownerEmail: contosoOwnerEmail } =
      await findOrgAndOwner(adminBPage, "contoso");
    const grant = await grantPlatformRole(adminBPage, contosoOwnerId, "admin");
    expect(grant.ok()).toBeTruthy();

    try {
      await signInStaff(adminBPage, "localtest.me:3000", contosoOwnerEmail);
      const feRes = await forceEnd(adminBPage, grantId);
      expect(feRes.ok()).toBeTruthy();

      // Admin A's own browser context still holds their real session +
      // signed admin_session cookie — the stop endpoint's restore branch
      // must find and use them.
      const stopRes = await adminAPage.request.post(
        `${API_URL}/rpc-admin/impersonation/stop`,
        { headers: { "x-platform-admin": "1" } },
      );
      expect(stopRes.ok()).toBeTruthy();

      // Cross-library cookie-signing compatibility (Condition 3): the cookie
      // this hand-rolled hono handler just wrote is subsequently accepted by
      // Better Auth's own `auth.api.getSession` — proven end to end via a
      // follow-up authenticated platform-admin request.
      const followUp = await adminAPage.request.get(`${API_URL}/rpc-admin/me`, {
        headers: { "x-platform-admin": "1" },
      });
      expect(followUp.ok()).toBeTruthy();
      const followUpBody = (await followUp.json()) as { platformRole: string | null };
      expect(followUpBody.platformRole).toBeTruthy();
    } finally {
      await revokePlatformRole(adminBPage, contosoOwnerEmail);
      await adminAContext.close();
      await adminBContext.close();
    }
  });

  test("restore-path rejection: a forged admin_session cookie with no corresponding grant is refused", async ({
    browser,
  }) => {
    // A signed-in platform admin who was never impersonating has no stashed
    // admin_session cookie at all — the existing `!impersonatedBy` branch
    // must still fall through to the same 400 it always has, not treat the
    // absence (or an unrelated forged cookie) as a valid restore.
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    await context.addCookies([
      {
        name: "better-auth.admin_session",
        value: "forged-not-a-real-signed-cookie",
        domain: "localtest.me",
        path: "/",
      },
    ]);

    const res = await page.request.post(`${API_URL}/rpc-admin/impersonation/stop`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(res.status()).toBe(400);

    await context.close();
  });
});
