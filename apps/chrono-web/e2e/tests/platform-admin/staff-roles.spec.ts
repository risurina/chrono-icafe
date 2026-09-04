import { test, expect } from "@playwright/test";

/**
 * Browser coverage for platform custom roles (`/admin/staff/roles`,
 * `/rpc-admin/staff/roles`). A custom role is composed from the same
 * PLATFORM_PERMISSION_STATEMENTS vocabulary the server enforces, ranks at the
 * floor (can never grant/manage an admin), and is assignable from
 * `/admin/staff` alongside viewer/support/admin. This suite drives the real
 * tenant/admin surface (same conventions as `staff.spec.ts`): it borrows the
 * seeded `owner@acme.test` as a throwaway assignment target and always reverts
 * it to null + deletes the test role in afterEach, so a mid-test failure never
 * leaves a stray platform-role holder or role row behind. `platform@agora.test`
 * (seeded platformRole "admin") acts throughout.
 *
 * Manual/headed suite: needs `pnpm dev` + seeded platform admin. Not run in CI.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const TEST_ROLE_KEY = "e2e-support-readonly";

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

/** Best-effort teardown: clear the borrowed owner's role, then delete the test role. */
async function cleanup(adminPage: import("@playwright/test").Page) {
  const staff = await adminPage.request.get(`${API_URL}/rpc-admin/staff`, {
    headers: { "x-platform-admin": "1" },
  });
  if (staff.ok()) {
    const body = (await staff.json()) as { items: { userId: string; email: string }[] };
    for (const item of body.items) {
      if (item.email === "owner@acme.test") {
        await adminPage.request.patch(
          `${API_URL}/rpc-admin/staff/${item.userId}/role`,
          { headers: { "x-platform-admin": "1" }, data: { role: null } },
        );
      }
    }
  }
  await adminPage.request.delete(
    `${API_URL}/rpc-admin/staff/roles/${TEST_ROLE_KEY}`,
    { headers: { "x-platform-admin": "1" } },
  );
}

test.describe("Platform custom roles", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await cleanup(page);
    await ctx.close();
  });

  test("happy path: create a floor-ranked custom role, see it in the editor, assign it", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const adminPage = await ctx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    // Create a read-only custom role (organization:read only).
    const create = await adminPage.request.post(`${API_URL}/rpc-admin/staff/roles`, {
      headers: { "x-platform-admin": "1" },
      data: {
        key: TEST_ROLE_KEY,
        name: "E2E Support (read-only)",
        description: "Read organizations only.",
        permission: { organization: ["read"] },
      },
    });
    expect(create.ok()).toBeTruthy();
    const created = (await create.json()) as { permission: Record<string, string[]> };
    // Permission is sanitized to the live vocabulary on the way back.
    expect(created.permission).toEqual({ organization: ["read"] });

    // The editor page renders the new role.
    await adminPage.goto("http://localtest.me:3000/admin/staff/roles");
    await adminPage.waitForLoadState("networkidle");
    await expect(adminPage.getByText("E2E Support (read-only)")).toBeVisible({
      timeout: 15_000,
    });

    // It is assignable to an existing user — resolve owner@acme.test's userId
    // via the org member lookup (not /rpc-admin/staff, which only lists
    // existing platform-role holders).
    const orgs = await adminPage.request.get(`${API_URL}/rpc-admin/organizations?q=acme`, {
      headers: { "x-platform-admin": "1" },
    });
    const acmeId = ((await orgs.json()) as { items: { id: string }[] }).items[0]?.id;
    expect(acmeId).toBeTruthy();
    const members = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${acmeId}/members`,
      { headers: { "x-platform-admin": "1" } },
    );
    const owner = ((await members.json()) as { items: { userId: string; email: string }[] }).items.find(
      (i) => i.email === "owner@acme.test",
    );
    expect(owner).toBeTruthy();
    const assign = await adminPage.request.patch(
      `${API_URL}/rpc-admin/staff/${owner!.userId}/role`,
      { headers: { "x-platform-admin": "1" }, data: { role: TEST_ROLE_KEY } },
    );
    expect(assign.ok()).toBeTruthy();
    expect((await assign.json()).platformRole).toBe(TEST_ROLE_KEY);

    await ctx.close();
  });

  test("guards: key collision 409, delete-while-assigned 409, unknown key 404, then delete 200", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const adminPage = await ctx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const H = { headers: { "x-platform-admin": "1" } };

    await adminPage.request.post(`${API_URL}/rpc-admin/staff/roles`, {
      ...H,
      data: { key: TEST_ROLE_KEY, name: "E2E Support (read-only)", permission: { organization: ["read"] } },
    });

    // A key colliding with a built-in system role is refused.
    const collision = await adminPage.request.post(`${API_URL}/rpc-admin/staff/roles`, {
      ...H,
      data: { key: "admin", name: "Nope", permission: {} },
    });
    expect(collision.status()).toBe(409);

    // Assign it, then deletion is refused while assigned. Resolve
    // owner@acme.test's userId via the org member lookup (not
    // /rpc-admin/staff, which only lists existing platform-role holders).
    const orgs = await adminPage.request.get(`${API_URL}/rpc-admin/organizations?q=acme`, H);
    const acmeId = ((await orgs.json()) as { items: { id: string }[] }).items[0]?.id;
    const members = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${acmeId}/members`,
      H,
    );
    const owner = ((await members.json()) as { items: { userId: string; email: string }[] }).items.find(
      (i) => i.email === "owner@acme.test",
    )!;
    await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${owner.userId}/role`, {
      ...H,
      data: { role: TEST_ROLE_KEY },
    });
    const delAssigned = await adminPage.request.delete(
      `${API_URL}/rpc-admin/staff/roles/${TEST_ROLE_KEY}`,
      H,
    );
    expect(delAssigned.status()).toBe(409);

    // Assigning a nonexistent custom key is refused.
    const unknown = await adminPage.request.patch(
      `${API_URL}/rpc-admin/staff/${owner.userId}/role`,
      { ...H, data: { role: "no-such-role-xyz" } },
    );
    expect(unknown.status()).toBe(404);

    // Unassign, then the delete succeeds.
    await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${owner.userId}/role`, {
      ...H,
      data: { role: null },
    });
    const delOk = await adminPage.request.delete(
      `${API_URL}/rpc-admin/staff/roles/${TEST_ROLE_KEY}`,
      H,
    );
    expect(delOk.ok()).toBeTruthy();

    await ctx.close();
  });
});
