import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the platform staff role grant surface (`/admin/staff`,
 * `PATCH /rpc-admin/staff/:userId/role`). Grants only apply to an existing `user`
 * row (no invite-by-email in this phase — see the plan's Out-of-Scope), so this
 * spec reuses the two seeded tenant owners (`owner@acme.test`, `owner@contoso.test`)
 * as throwaway platform-role targets instead of creating new accounts, and always
 * reverts their `platformRole` back to null in `afterEach` so a mid-test failure
 * never leaves a stray platform-role holder. `platform@agora.test` (seeded
 * platformRole: "admin") stays the platform admin acting throughout.
 *
 * This suite runs `fullyParallel: false, workers: 1` against the real dev DB —
 * same conventions as `organizations.spec.ts`.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

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

/** Revert a seeded account's platform role to null via a direct admin PATCH. */
async function revokeRole(adminPage: import("@playwright/test").Page) {
  // Best-effort cleanup — grab the current staff list and clear any role held
  // by the two seeded tenant owners this spec borrows as test targets.
  const res = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, {
    headers: { "x-platform-admin": "1" },
  });
  if (!res.ok()) return;
  const body = (await res.json()) as { items: { userId: string; email: string }[] };
  for (const item of body.items) {
    if (item.email === "owner@acme.test" || item.email === "owner@contoso.test") {
      await adminPage.request.patch(
        `${API_URL}/rpc-admin/staff/${item.userId}/role`,
        {
          headers: { "x-platform-admin": "1" },
          data: { role: null },
        },
      );
    }
  }
}

test.describe("Platform Staff", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await revokeRole(page);
    await ctx.close();
  });

  test("an admin grants and revokes a platform role for an existing account", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    // Find owner@acme.test's userId (there is no invite-by-email UI in this
    // phase — the grant applies only to an existing account) and grant it a
    // platform role directly, since /admin/staff only lists existing holders.
    const orgsRes = await page.request.get(
      `${API_URL}/rpc-admin/organizations?q=acme`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(orgsRes.ok()).toBeTruthy();
    const orgsBody = (await orgsRes.json()) as {
      items: { id: string; slug: string }[];
    };
    const acmeId = orgsBody.items.find((o) => o.slug === "acme")?.id;
    expect(acmeId).toBeTruthy();
    const membersRes = await page.request.get(
      `${API_URL}/rpc-admin/organizations/${acmeId}/members`,
      { headers: { "x-platform-admin": "1" } },
    );
    const membersBody = (await membersRes.json()) as {
      items: { userId: string; email: string }[];
    };
    const acmeOwner = membersBody.items.find((m) => m.email === "owner@acme.test");
    expect(acmeOwner).toBeTruthy();

    const grantRes = await page.request.patch(
      `${API_URL}/rpc-admin/staff/${acmeOwner!.userId}/role`,
      { headers: { "x-platform-admin": "1" }, data: { role: "viewer" } },
    );
    expect(grantRes.ok()).toBeTruthy();

    await page.goto("http://localtest.me:3000/admin/staff");
    await page.waitForLoadState("networkidle");
    const row = page.getByRole("row").filter({ hasText: "owner@acme.test" });
    await expect(row.getByText("viewer")).toBeVisible();

    // Promote to admin via the Manage dialog's role Select.
    await row.getByRole("button", { name: "Manage" }).click();
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "admin" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText(/is now a platform admin/i)).toBeVisible();
    await expect(row.getByText("admin")).toBeVisible();

    // Revoke entirely via the Manage dialog — this leaves platform@agora.test
    // as the sole remaining admin, so it must succeed (not the last-admin case).
    await row.getByRole("button", { name: "Manage" }).click();
    await page.getByRole("button", { name: "Revoke access" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(page.getByText(/platform access was revoked/i)).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "owner@acme.test" })).toHaveCount(0);
  });

  test("a viewer sees the staff list but not the role-change controls, and a direct PATCH is rejected", async ({
    page,
    browser,
  }) => {
    // Grant owner@contoso.test the "viewer" platform role as the seeded admin.
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const orgsRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations?q=contoso`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(orgsRes.ok()).toBeTruthy();
    const orgsBody = (await orgsRes.json()) as {
      items: { id: string; slug: string }[];
    };
    const contosoId = orgsBody.items.find((o) => o.slug === "contoso")?.id;
    expect(contosoId).toBeTruthy();
    const membersRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${contosoId}/members`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(membersRes.ok()).toBeTruthy();
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

    // Sign in as the newly-granted viewer and check the portal.
    await page.goto("http://localtest.me:3000/login");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill("owner@contoso.test");
    await page.getByLabel("Password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
      timeout: 15_000,
    });
    await page.goto("http://localtest.me:3000/admin/staff");
    await page.waitForLoadState("networkidle");
    const ownRow = page.getByRole("row").filter({ hasText: "owner@contoso.test" });
    await expect(ownRow.getByText("owner@contoso.test")).toBeVisible();

    // Open the Manage dialog (unconditional) — the role-change/Revoke controls
    // inside it are permission-gated and must not render for a viewer.
    await ownRow.getByRole("button", { name: "Manage" }).click();
    await expect(page.getByRole("combobox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Revoke access" })).toHaveCount(0);

    // The viewer cannot reach the mutating route directly either.
    const directPatch = await page.request.patch(
      `${API_URL}/rpc-admin/staff/${contosoOwner!.userId}/role`,
      { headers: { "x-platform-admin": "1" }, data: { role: "admin" } },
    );
    expect(directPatch.status()).toBe(403);

    await adminCtx.close();
  });

  test("revoking the last remaining platform admin is rejected", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    // Find the seeded platform admin's own userId via the staff list.
    const listRes = await page.request.get(`${API_URL}/rpc-admin/staff`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(listRes.ok()).toBeTruthy();
    const listBody = (await listRes.json()) as {
      items: { userId: string; email: string; platformRole: string }[];
    };
    const admins = listBody.items.filter((i) => i.platformRole === "admin");
    // In a clean seeded environment there is exactly one admin
    // (platform@agora.test); revoking it must be rejected.
    if (admins.length !== 1) {
      test.skip(true, "environment has more than one platform admin already");
    }
    const lastAdmin = admins[0]!;

    await page.goto("http://localtest.me:3000/admin/staff");
    await page.waitForLoadState("networkidle");
    const row = page.getByRole("row").filter({ hasText: lastAdmin.email });
    await row.getByRole("button", { name: "Manage" }).click();
    await page.getByRole("button", { name: "Revoke access" }).click();
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(
      page.getByText(/last platform admin/i),
    ).toBeVisible({ timeout: 15_000 });

    // Server-side: the row still reports "admin" without a full reload.
    await expect(row.getByText("admin")).toBeVisible();

    // And the direct API call is refused the same way.
    const directRes = await page.request.patch(
      `${API_URL}/rpc-admin/staff/${lastAdmin.userId}/role`,
      { headers: { "x-platform-admin": "1" }, data: { role: null } },
    );
    expect(directRes.status()).toBe(400);
  });
});
