import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the platform System Settings surface
 * (`/admin/settings`, `GET`/`PATCH /rpc-admin/settings`, spec #14). The
 * gate/guard coverage — read/write permission gate, `.strict()`/type
 * validation, critical-key audit, and maintenance/read-only/disable-
 * registration ENFORCEMENT — is proven at the HTTP level in
 * `apps/api/src/e2e/run.ts` (search "W2s. Platform System Settings" and
 * "W2s-enforce"), which asserts against real seeded platform-role accounts
 * with no browser. This spec covers what only a browser can prove: the hub
 * page itself, role-based visibility of editable controls, and the
 * Danger-Zone confirm dialog.
 *
 * Runs against the real dev DB — same conventions as `security-policy.spec.ts`
 * (`fullyParallel: false`, `workers: 1`, no `webServer` — `pnpm dev` must be
 * running).
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

/** Always leave every settings flag at its registry default. */
async function resetSettings(page: import("@playwright/test").Page) {
  await page.request.patch(`${API_URL}/rpc-admin/settings`, {
    headers: { "x-platform-admin": "1" },
    data: {
      "general.platformName": "Agora",
      "maintenance.mode": false,
      "danger.readOnlyMode": false,
      "danger.disableRegistrations": false,
    },
  });
}

test.describe("Platform System Settings", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await resetSettings(page);
    await ctx.close();
  });

  test("an admin edits a General setting and it persists on reload", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/settings");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("System settings").first()).toBeVisible();
    const input = page.getByLabel("Platform name");
    await input.fill("Acme Platform");
    await input.locator("xpath=following-sibling::button[normalize-space()='Save']").click();
    await expect(page.getByText("Setting saved.")).toBeVisible();

    const res = await page.request.get(`${API_URL}/rpc-admin/settings`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { settings: { key: string; value: unknown }[] };
    const name = body.settings.find((s) => s.key === "general.platformName");
    expect(name?.value).toBe("Acme Platform");
  });

  test("a viewer sees no editable controls and a direct PATCH is rejected", async ({
    page,
    browser,
  }) => {
    // Grant owner@contoso.test the "viewer" platform role, as in staff.spec.ts.
    const adminCtx = await browser.newContext();
    const adminPage = await adminCtx.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const orgsRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations?search=contoso`,
      { headers: { "x-platform-admin": "1" } },
    );
    const orgsBody = (await orgsRes.json()) as { items: { id: string }[] };
    const contosoId = orgsBody.items[0]?.id;
    const membersRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${contosoId}/members`,
      { headers: { "x-platform-admin": "1" } },
    );
    const membersBody = (await membersRes.json()) as {
      items: { userId: string; email: string }[];
    };
    const contosoOwner = membersBody.items.find((m) => m.email === "owner@contoso.test");
    await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${contosoOwner!.userId}/role`, {
      headers: { "x-platform-admin": "1" },
      data: { role: "viewer" },
    });

    await page.goto("http://localtest.me:3000/login");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill("owner@contoso.test");
    await page.getByLabel("Password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15_000 });

    await page.goto("http://localtest.me:3000/admin/settings");
    await page.waitForLoadState("networkidle");
    // Every editable control (Save button / Switch) is hidden for a viewer.
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(page.getByRole("switch")).toHaveCount(0);

    const directPatch = await page.request.patch(`${API_URL}/rpc-admin/settings`, {
      headers: { "x-platform-admin": "1" },
      data: { "general.platformName": "Nope" },
    });
    expect(directPatch.status()).toBe(403);

    // Cleanup: revoke the viewer role.
    await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${contosoOwner!.userId}/role`, {
      headers: { "x-platform-admin": "1" },
      data: { role: null },
    });
    await adminCtx.close();
  });

  test("a Danger-Zone toggle requires the confirm dialog before it writes", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/settings");
    await page.waitForLoadState("networkidle");

    const toggle = page.getByRole("switch", { name: /toggle maintenance mode/i });
    await toggle.click();
    // The confirm dialog names the platform-wide blast radius before any write.
    await expect(page.getByText(/affects every business on the platform/i)).toBeVisible();

    // Cancelling leaves the value unchanged.
    await page.getByRole("button", { name: "Cancel" }).click();
    const afterCancel = await page.request.get(`${API_URL}/rpc-admin/settings`, {
      headers: { "x-platform-admin": "1" },
    });
    const cancelBody = (await afterCancel.json()) as {
      settings: { key: string; value: unknown }[];
    };
    expect(
      cancelBody.settings.find((s) => s.key === "maintenance.mode")?.value,
    ).toBe(false);

    // Confirming fires the write.
    await toggle.click();
    await page.getByRole("button", { name: "Turn on" }).click();
    await expect(page.getByText("Setting saved.")).toBeVisible();
    const afterConfirm = await page.request.get(`${API_URL}/rpc-admin/settings`, {
      headers: { "x-platform-admin": "1" },
    });
    const confirmBody = (await afterConfirm.json()) as {
      settings: { key: string; value: unknown }[];
    };
    expect(
      confirmBody.settings.find((s) => s.key === "maintenance.mode")?.value,
    ).toBe(true);

    // The critical change is audited.
    const audit = await page.request.get(`${API_URL}/rpc-admin/audit?pageSize=100`, {
      headers: { "x-platform-admin": "1" },
    });
    const auditBody = (await audit.json()) as { items: { action: string }[] };
    expect(auditBody.items.some((r) => r.action === "platform.setting.changed")).toBeTruthy();
  });

  test("maintenance mode blocks tenant traffic while the admin surface stays up", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    await page.request.patch(`${API_URL}/rpc-admin/settings`, {
      headers: { "x-platform-admin": "1" },
      data: { "maintenance.mode": true },
    });

    // A tenant /rpc request is refused with a 503…
    const tenantReq = await page.request.get(`${API_URL}/rpc/me`, {
      headers: { "x-tenant-slug": "acme" },
    });
    expect(tenantReq.status()).toBe(503);

    // …while the admin settings surface still loads so it can be turned off.
    await page.goto("http://localtest.me:3000/admin/settings");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("System settings").first()).toBeVisible();
  });
});
