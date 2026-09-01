import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the platform admin announcement CRUD surface:
 * `GET`/`POST /rpc-admin/announcements`, `GET`/`PATCH`/`DELETE
 * /rpc-admin/announcements/:id`, `POST /rpc-admin/announcements/:id/retire`.
 * Not tenant-scoped — no tenant-isolation angle here, see
 * `announcements/tenant-visibility.spec.ts` for that (the mandatory
 * tenant-facing trio). This spec covers the role gate + full CRUD round trip.
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

test.describe("Platform Admin — Announcements", () => {
  test.afterEach(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await revokeRole(page, "owner@acme.test");
    await ctx.close();
  });

  test("a platform viewer can read but is blocked from create/update/retire/delete", async ({
    page,
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    // Seed an announcement as admin to have something to try to mutate.
    const createRes = await adminPage.request.post(
      `${API_URL}/rpc-admin/announcements`,
      {
        headers: { "x-platform-admin": "1" },
        data: { message: `viewer-gate-${Date.now()}`, severity: "info" },
      },
    );
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as { id: string };

    // Grant the seeded acme owner the platform "viewer" role.
    const acmeRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations?search=acme`,
      { headers: { "x-platform-admin": "1" } },
    );
    const acmeBody = (await acmeRes.json()) as { items: { id: string }[] };
    const acmeId = acmeBody.items[0]?.id;
    const membersRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${acmeId}/members`,
      { headers: { "x-platform-admin": "1" } },
    );
    const membersBody = (await membersRes.json()) as {
      items: { userId: string; email: string }[];
    };
    const acmeOwner = membersBody.items.find((m) => m.email === "owner@acme.test");
    expect(acmeOwner).toBeTruthy();
    const grantRes = await adminPage.request.patch(
      `${API_URL}/rpc-admin/staff/${acmeOwner!.userId}/role`,
      { headers: { "x-platform-admin": "1" }, data: { role: "viewer" } },
    );
    expect(grantRes.ok()).toBeTruthy();

    await signInStaff(page, "localtest.me:3000", "owner@acme.test");

    // Read access works.
    const getRes = await page.request.get(`${API_URL}/rpc-admin/announcements`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(getRes.ok()).toBeTruthy();

    // Every mutating action is rejected server-side — not merely hidden.
    const postRes = await page.request.post(`${API_URL}/rpc-admin/announcements`, {
      headers: { "x-platform-admin": "1" },
      data: { message: "blocked", severity: "info" },
    });
    expect(postRes.status()).toBe(403);

    const patchRes = await page.request.patch(
      `${API_URL}/rpc-admin/announcements/${created.id}`,
      { headers: { "x-platform-admin": "1" }, data: { message: "blocked" } },
    );
    expect(patchRes.status()).toBe(403);

    const retireRes = await page.request.post(
      `${API_URL}/rpc-admin/announcements/${created.id}/retire`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(retireRes.status()).toBe(403);

    const deleteRes = await page.request.delete(
      `${API_URL}/rpc-admin/announcements/${created.id}`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(deleteRes.status()).toBe(403);

    // The UI itself hides the manage controls (visibility only).
    await page.goto(`http://localtest.me:3000/admin/announcements/${created.id}`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

    await adminContext.close();

    // Cleanup as admin.
    const cleanupCtx = await browser.newContext();
    const cleanupPage = await cleanupCtx.newPage();
    await signInStaff(cleanupPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await cleanupPage.request.delete(
      `${API_URL}/rpc-admin/announcements/${created.id}`,
      { headers: { "x-platform-admin": "1" } },
    );
    await cleanupCtx.close();
  });

  test("admin performs the full CRUD round trip; unknown id 404s", async ({ page }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const marker = `E2E-ANNOUNCE-${Date.now()}`;

    await page.goto("http://localtest.me:3000/admin/announcements/new");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Message").fill(marker);
    await page.getByRole("button", { name: "Create announcement" }).click();
    await page.waitForURL(/\/admin\/announcements\/[^/]+$/, { timeout: 15_000 });

    // The edit page's own GET (loading the just-created row) can resolve
    // after navigation — wait for it to populate the field with the
    // original marker before typing, or a late fetch clobbers the edit.
    await expect(page.getByLabel("Message")).toHaveValue(marker, { timeout: 15_000 });

    // Update.
    await page.getByLabel("Message").fill(`${marker}-updated`);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Announcement saved.")).toBeVisible();

    // It shows up in the list.
    await page.goto("http://localtest.me:3000/admin/announcements");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(`${marker}-updated`)).toBeVisible();

    // Retire — the list row's message text is plain, not a link; "Edit" is.
    await page
      .locator("tr", { hasText: `${marker}-updated` })
      .getByRole("link", { name: "Edit" })
      .click();
    await page.waitForURL(/\/admin\/announcements\/[^/]+$/, { timeout: 15_000 });
    await page.getByRole("button", { name: "Retire now" }).click();
    await expect(page.getByText("Announcement retired.")).toBeVisible();
    await expect(page.getByText("not live")).toBeVisible();

    // Delete.
    await page.getByRole("button", { name: "Delete" }).click();
    await page.getByRole("button", { name: "Delete" }).last().click();
    await page.waitForURL(/\/admin\/announcements$/, { timeout: 15_000 });

    // Unknown id 404s.
    const notFoundRes = await page.request.get(
      `${API_URL}/rpc-admin/announcements/does-not-exist`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(notFoundRes.status()).toBe(404);
  });
});
