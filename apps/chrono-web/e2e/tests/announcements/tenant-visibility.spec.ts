import { test, expect } from "@playwright/test";

/**
 * The mandatory tenant-facing trio for the `activeAnnouncements` field folded
 * into `GET /rpc/me` (`.ai/plans/agora/active/platform-announcements/README.md`).
 * Not a per-tenant resource — the data has no tenant dimension by design —
 * so "isolation" here is narrower than the usual tenant-A-cannot-see-
 * tenant-B's-rows shape: an unauthenticated/non-member request must not
 * reach the data at all, and a member of tenant A sending a
 * mismatched/injected `x-tenant-slug` for tenant B must be rejected by
 * `tenantMiddleware()` itself — not silently honored, and not used to filter
 * announcement data, since there is nothing tenant-scoped to filter by.
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

/** Sign up a fresh workspace; returns its slug. */
async function createWorkspace(
  page: import("@playwright/test").Page,
  tag: string,
): Promise<string> {
  const uniq = Date.now();
  const slug = `test-ann${tag}${uniq}`.replace(/[^a-z0-9-]/g, "");
  const email = `test-ann${tag}${uniq}@example.com`;

  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill("PW Announce");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Workspace name").fill(slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
  return slug;
}

/** Call `/rpc/me` from inside the page so the browser attaches the session cookie. */
async function fetchMe(
  page: import("@playwright/test").Page,
  tenantSlug: string,
): Promise<{ status: number; body: any }> {
  return page.evaluate(async (slug) => {
    const api = location.origin.replace(/:3000$/, ":8787");
    const res = await fetch(`${api}/rpc/me`, {
      credentials: "include",
      headers: { "x-tenant-slug": slug },
    });
    return { status: res.status, body: res.ok ? await res.json() : null };
  }, tenantSlug);
}

test.describe("Announcements — tenant-facing visibility", () => {
  test("happy path: a published announcement renders in the dashboard banner of a real tenant", async ({
    page,
    browser,
  }) => {
    const slug = await createWorkspace(page, "happy");
    const marker = `E2E-BANNER-${Date.now()}`;

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const createRes = await adminPage.request.post(
      `${API_URL}/rpc-admin/announcements`,
      {
        headers: { "x-platform-admin": "1" },
        data: { message: marker, severity: "warning" },
      },
    );
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as { id: string };

    await page.goto(`http://${slug}.localtest.me:3000/dashboard`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(marker)).toBeVisible({ timeout: 25_000 });

    // Retiring it removes it within one poll interval.
    await adminPage.request.post(
      `${API_URL}/rpc-admin/announcements/${created.id}/retire`,
      { headers: { "x-platform-admin": "1" } },
    );
    await expect(page.getByText(marker)).toHaveCount(0, { timeout: 25_000 });

    await adminPage.request.delete(`${API_URL}/rpc-admin/announcements/${created.id}`, {
      headers: { "x-platform-admin": "1" },
    });
    await adminContext.close();
  });

  test("role gate, by status code: no session -> redirect/401; valid session but not a member -> 403", async ({
    page,
    browser,
  }) => {
    const slugA = await createWorkspace(page, "a");

    // Unauthenticated: visiting the tenant dashboard redirects to /login.
    const unauthContext = await browser.newContext();
    const unauthPage = await unauthContext.newPage();
    await unauthPage.goto(`http://${slugA}.localtest.me:3000/dashboard`);
    await unauthPage.waitForURL((url) => url.pathname.startsWith("/login"), {
      timeout: 15_000,
    });

    // A direct call to /rpc/me with no session cookie -> 401.
    const noSessionRes = await unauthPage.request.get(`${API_URL}/rpc/me`, {
      headers: { "x-tenant-slug": slugA },
    });
    expect(noSessionRes.status()).toBe(401);
    await unauthContext.close();

    // A valid session, but not a member of the claimed tenant -> 403, never
    // the announcement content. `page` stays signed in as tenant A's owner;
    // workspace B is created in a throwaway context so it doesn't overwrite
    // `page`'s own session cookie.
    const bCtx = await browser.newContext();
    const bPage = await bCtx.newPage();
    const slugB = await createWorkspace(bPage, "b");
    await bCtx.close();

    const meFromA = await fetchMe(page, slugB);
    expect(meFromA.status).toBe(403);
    expect(meFromA.body).toBeNull();
  });

  test("cross-tenant isolation, restated for what's checkable: identical data across tenants; mismatched slug is rejected, not honored", async ({
    browser,
  }) => {
    const marker = `E2E-XTENANT-${Date.now()}`;

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const createRes = await adminPage.request.post(
      `${API_URL}/rpc-admin/announcements`,
      {
        headers: { "x-platform-admin": "1" },
        data: { message: marker, severity: "info" },
      },
    );
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as { id: string };

    // Two members on two different tenants, each calling /rpc/me on their
    // own tenant's host, get identical activeAnnouncements data.
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    const slugA = await createWorkspace(pageA, "xa");
    const meA = await fetchMe(pageA, slugA);
    expect(meA.status).toBe(200);
    const idsA = (meA.body.activeAnnouncements as { id: string }[]).map((a) => a.id);
    expect(idsA).toContain(created.id);

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    const slugB = await createWorkspace(pageB, "xb");
    const meB = await fetchMe(pageB, slugB);
    expect(meB.status).toBe(200);
    const idsB = (meB.body.activeAnnouncements as { id: string }[]).map((a) => a.id);
    expect(idsB).toContain(created.id);
    expect(idsA.sort()).toEqual(idsB.sort());

    // A member of tenant A sending x-tenant-slug: <tenant-B-slug> gets 403
    // from the middleware itself — the header is authorized, not honored.
    const crossRes = await fetchMe(pageA, slugB);
    expect(crossRes.status).toBe(403);
    expect(crossRes.body).toBeNull();

    // A nonexistent slug -> 404, not 200/403.
    const bogusRes = await fetchMe(pageA, `does-not-exist-${Date.now()}`);
    expect(bogusRes.status).toBe(404);

    await adminPage.request.delete(`${API_URL}/rpc-admin/announcements/${created.id}`, {
      headers: { "x-platform-admin": "1" },
    });
    await adminContext.close();
    await ctxA.close();
    await ctxB.close();
  });
});
