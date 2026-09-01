import { test, expect } from "@playwright/test";

/**
 * Targeting-narrowing + read-ack coverage for the announcements extension
 * (`.ai/plans/agora/active/platform-announcements/README.md`). The base
 * `tenant-visibility.spec.ts` predates targeting and asserts every tenant sees
 * the same set — that premise is now conditional. Here the new isolation
 * concern is proven directly: an announcement targeted at tenant A (by org id)
 * reaches tenant A's `/rpc/me` and is ABSENT from tenant B's, and the per-user
 * read-ack route (`POST /rpc/announcements/:id/read`) is scoped to the caller
 * and no-ops on a stale id rather than 500-ing on the FK.
 *
 * Manual/headed suite: needs `pnpm dev` + the seeded platform admin, like the
 * sibling spec. Not run in CI.
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

/** Resolve an org id from its slug via the platform admin org list. */
async function resolveOrgId(
  adminPage: import("@playwright/test").Page,
  slug: string,
): Promise<string> {
  const res = await adminPage.request.get(
    `${API_URL}/rpc-admin/organizations?q=${slug}&pageSize=5`,
    { headers: { "x-platform-admin": "1" } },
  );
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; slug: string }[] };
  const match = body.items.find((o) => o.slug === slug);
  expect(match, `org for slug ${slug}`).toBeTruthy();
  return match!.id;
}

/** `/rpc/me` from inside the page so the browser attaches the session cookie. */
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

/** POST the read-ack for an announcement id from inside the page. */
async function postRead(
  page: import("@playwright/test").Page,
  tenantSlug: string,
  id: string,
): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ slug, annId }) => {
      const api = location.origin.replace(/:3000$/, ":8787");
      const res = await fetch(`${api}/rpc/announcements/${annId}/read`, {
        method: "POST",
        credentials: "include",
        headers: { "x-tenant-slug": slug, "content-type": "application/json" },
        body: "{}",
      });
      return { status: res.status, body: res.ok ? await res.json() : null };
    },
    { slug: tenantSlug, annId: id },
  );
}

test.describe("Announcements — targeting narrowing + read-ack", () => {
  test("happy path + isolation: a tenant-targeted announcement reaches only the targeted tenant", async ({
    browser,
  }) => {
    const marker = `E2E-TARGET-${Date.now()}`;

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    const slugA = await createWorkspace(pageA, "gta");

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    const slugB = await createWorkspace(pageB, "gtb");

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    const orgIdA = await resolveOrgId(adminPage, slugA);

    // Target tenant A only, in-app channel.
    const createRes = await adminPage.request.post(
      `${API_URL}/rpc-admin/announcements`,
      {
        headers: { "x-platform-admin": "1" },
        data: {
          message: marker,
          severity: "info",
          channels: ["in_app"],
          targeting: { mode: "tenants", tenantIds: [orgIdA] },
        },
      },
    );
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as { id: string };

    // Tenant A (targeted) sees it; tenant B (not targeted) does not.
    const meA = await fetchMe(pageA, slugA);
    expect(meA.status).toBe(200);
    const idsA = (meA.body.activeAnnouncements as { id: string }[]).map((a) => a.id);
    expect(idsA).toContain(created.id);

    const meB = await fetchMe(pageB, slugB);
    expect(meB.status).toBe(200);
    const idsB = (meB.body.activeAnnouncements as { id: string }[]).map((a) => a.id);
    expect(idsB).not.toContain(created.id);

    await adminPage.request.delete(
      `${API_URL}/rpc-admin/announcements/${created.id}`,
      { headers: { "x-platform-admin": "1" } },
    );
    await adminContext.close();
    await ctxA.close();
    await ctxB.close();
  });

  test("read-ack is scoped to the caller and no-ops on a stale id", async ({
    browser,
  }) => {
    const marker = `E2E-ACK-${Date.now()}`;

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    const slugA = await createWorkspace(pageA, "acka");

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const createRes = await adminPage.request.post(
      `${API_URL}/rpc-admin/announcements`,
      {
        headers: { "x-platform-admin": "1" },
        data: { message: marker, severity: "info", channels: ["in_app"] },
      },
    );
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as { id: string };

    // A real id acknowledges cleanly; a second call is idempotent (upsert).
    const ack1 = await postRead(pageA, slugA, created.id);
    expect(ack1.status).toBe(200);
    expect(ack1.body).toEqual({ ok: true });
    const ack2 = await postRead(pageA, slugA, created.id);
    expect(ack2.status).toBe(200);

    // A stale/nonexistent id is a no-op, never a 500 on the FK.
    const ackStale = await postRead(pageA, slugA, `bogus-${Date.now()}`);
    expect(ackStale.status).toBe(200);
    expect(ackStale.body).toEqual({ ok: true });

    // The stats panel now reflects one in-app read for the real announcement.
    const statsRes = await adminPage.request.get(
      `${API_URL}/rpc-admin/announcements/${created.id}/stats`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(statsRes.ok()).toBeTruthy();

    await adminPage.request.delete(
      `${API_URL}/rpc-admin/announcements/${created.id}`,
      { headers: { "x-platform-admin": "1" } },
    );
    await adminContext.close();
    await ctxA.close();
  });
});
