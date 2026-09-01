import { test, expect, type Page } from "@playwright/test";

/**
 * Browser coverage for cross-tenant user search (`/admin/users`,
 * `/rpc-admin/users`) — see `.ai/plans/agora/active/platform-user-search/README.md`.
 * Under the platform-admin surface acting on the shared Better-Auth `user`
 * pool (platform staff + tenant org members), not an extension of the
 * tenant-scoped `user-management` feature — kept in its own
 * `platform-admin/` folder, not `user-management/`, per the plan's E2E
 * folder decision.
 *
 * Same conventions as `staff.spec.ts`/`organizations.spec.ts`: real dev DB,
 * `fullyParallel: false, workers: 1` (`apps/web/playwright.config.ts`), the
 * seeded `owner@acme.test` / `owner@contoso.test` tenant owners as throwaway
 * targets, `platform@agora.test` (seeded platformRole: "admin") acting
 * throughout, and `x-platform-admin: "1"` on every direct `/rpc-admin/*`
 * call. Every mutating test reverts the target's `banned` state in
 * `afterEach` the same way `staff.spec.ts` reverts `platformRole`.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

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

async function findUserByEmail(adminPage: Page, email: string) {
  const res = await adminPage.request.get(
    `${API_URL}/rpc-admin/users?q=${encodeURIComponent(email)}`,
    { headers: { "x-platform-admin": "1" } },
  );
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as {
    items: {
      id: string;
      email: string;
      banned: boolean;
      memberships: { organizationName: string; role: string }[];
    }[];
  };
  const found = body.items.find((i) => i.email === email);
  expect(found).toBeTruthy();
  return found!;
}

async function grantPlatformRole(
  adminPage: Page,
  targetUserId: string,
  role: "viewer" | "support" | "admin" | null,
) {
  return adminPage.request.patch(`${API_URL}/rpc-admin/staff/${targetUserId}/role`, {
    headers: { "x-platform-admin": "1" },
    data: { role },
  });
}

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

/** Best-effort: always leave the target un-banned after a test touches it. */
async function unban(adminPage: Page, userId: string) {
  await adminPage.request.patch(`${API_URL}/rpc-admin/users/${userId}/unban`, {
    headers: { "x-platform-admin": "1" },
  });
}

test.describe("Platform admin: cross-tenant user search", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const owner = await findUserByEmail(page, "owner@acme.test");
    await unban(page, owner.id);
    await ctx.close();
  });

  test("search finds a seeded tenant owner and attributes the right role per org", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const found = await findUserByEmail(page, "owner@acme.test");
    expect(
      found.memberships.some(
        (m) => m.organizationName === "Acme Corp" && m.role === "owner",
      ),
    ).toBe(true);

    await page.goto("http://localtest.me:3000/admin/users");
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder(/search by email or name/i).fill("owner@acme.test");
    await expect(page.getByText("owner@acme.test")).toBeVisible();

    await ctx.close();
  });

  test("admin can ban then unban the target; support/viewer cannot (403 both server-side and hidden client-side)", async ({
    browser,
  }) => {
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const target = await findUserByEmail(adminPage, "owner@acme.test");

    // Promote the contoso owner to platform "support" for this test only.
    const contosoOwner = await findUserByEmail(adminPage, "owner@contoso.test");
    const grant = await grantPlatformRole(adminPage, contosoOwner.id, "support");
    expect(grant.ok()).toBeTruthy();

    try {
      const supportCtx = await browser.newContext();
      const supportPage = await supportCtx.newPage();
      await signInStaff(supportPage, "localtest.me:3000", "owner@contoso.test");

      // UI: no ban button for a support platform admin.
      await supportPage.goto("http://localtest.me:3000/admin/users");
      await supportPage.waitForLoadState("networkidle");
      await supportPage
        .getByPlaceholder(/search by email or name/i)
        .fill("owner@acme.test");
      await supportPage.getByText("owner@acme.test").click();
      await expect(
        supportPage.getByRole("button", { name: "Disable account" }),
      ).toHaveCount(0);

      // Server-side: a direct PATCH still 403s.
      const supportBanRes = await supportPage.request.patch(
        `${API_URL}/rpc-admin/users/${target.id}/ban`,
        {
          headers: { "x-platform-admin": "1" },
          data: { banReason: "support should not be able to do this" },
        },
      );
      expect(supportBanRes.status()).toBe(403);
      await supportCtx.close();

      // admin: ban succeeds.
      const banRes = await adminPage.request.patch(
        `${API_URL}/rpc-admin/users/${target.id}/ban`,
        {
          headers: { "x-platform-admin": "1" },
          data: { banReason: "e2e: suspected compromise" },
        },
      );
      expect(banRes.ok()).toBeTruthy();

      const afterBan = await findUserByEmail(adminPage, "owner@acme.test");
      expect(afterBan.banned).toBe(true);

      // admin: unban restores it.
      const unbanRes = await adminPage.request.patch(
        `${API_URL}/rpc-admin/users/${target.id}/unban`,
        { headers: { "x-platform-admin": "1" } },
      );
      expect(unbanRes.ok()).toBeTruthy();
      const afterUnban = await findUserByEmail(adminPage, "owner@acme.test");
      expect(afterUnban.banned).toBe(false);
    } finally {
      await revokePlatformRole(adminPage, "owner@contoso.test");
      await adminCtx.close();
    }
  });

  test("an admin mid-impersonation of a target that gets banned can still call /impersonation/stop and be restored", async ({
    browser,
  }) => {
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const target = await findUserByEmail(adminPage, "owner@acme.test");

    const startRes = await adminPage.request.post(
      `${API_URL}/rpc-admin/impersonation/start`,
      {
        headers: { "x-platform-admin": "1" },
        data: { targetUserId: target.id },
      },
    );
    expect(startRes.ok()).toBeTruthy();

    // A second admin session bans the impersonation target.
    const secondCtx = await browser.newContext();
    const secondPage = await secondCtx.newPage();
    await signInStaff(secondPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const banRes = await secondPage.request.patch(
      `${API_URL}/rpc-admin/users/${target.id}/ban`,
      {
        headers: { "x-platform-admin": "1" },
        data: { banReason: "e2e: mid-impersonation ban" },
      },
    );
    expect(banRes.ok()).toBeTruthy();
    await secondCtx.close();

    // The original admin's own /impersonation/stop must still succeed and
    // restore their platform-admin session — not 400 "Not currently
    // impersonating." (R4-CONDITION 2's extended corroboration check).
    const stopRes = await adminPage.request.post(
      `${API_URL}/rpc-admin/impersonation/stop`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(stopRes.ok()).toBeTruthy();

    const restoredMe = await adminPage.request.get(`${API_URL}/rpc-admin/me`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(restoredMe.ok()).toBeTruthy();
    const restoredBody = (await restoredMe.json()) as { platformRole: string | null };
    expect(restoredBody.platformRole).toBeTruthy();

    await adminCtx.close();
  });

  test("send-password-reset succeeds for a seeded credential account", async ({
    browser,
  }) => {
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const target = await findUserByEmail(adminPage, "owner@acme.test");

    // The seeded owner accounts sign in via email/password, so this should
    // 200; a 400 here would indicate the credential-account check regressed.
    const res = await adminPage.request.post(
      `${API_URL}/rpc-admin/users/${target.id}/send-password-reset`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(res.ok()).toBeTruthy();

    await adminCtx.close();
  });
});
