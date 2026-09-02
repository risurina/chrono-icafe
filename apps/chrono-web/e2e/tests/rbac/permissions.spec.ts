import { test, expect } from "@playwright/test";

/**
 * Browser coverage for permission-driven UI gating on the members settings page.
 *
 * MANUAL suite: `apps/web/playwright.config.ts` runs headed with `slowMo` and declares
 * no `webServer`, so this needs `pnpm dev` already running.
 *
 * Scope is deliberately narrow. The authorization *decisions* — allow, deny, the
 * API-key actor, cross-tenant refusal, and the owner-only billing boundary — are
 * proven in the enforced API suite (`pnpm test:e2e` → `apps/api/src/e2e/run.ts`),
 * which can mint a staff session directly. What only a browser can prove, and all
 * this file asserts, is that the *rendered page* follows the permission set: the
 * owner sees the gated controls, and the permission set behind them is real.
 *
 * Every assertion here must be able to fail. A test that signs up a fresh workspace
 * is always signed in as `owner` (`creatorRole: "owner"`), so it cannot demonstrate
 * denial — attempting that in the browser would be a test that passes no matter what.
 */
/**
 * Call `/rpc/me` from inside the page, so the browser attaches the session cookie.
 *
 * The API origin is derived from the page's own origin rather than read from
 * NEXT_PUBLIC_API_URL: that variable is baked into the app at build time and is
 * NOT loaded in the Playwright node process, so reading it here yields the
 * `localhost:8787` fallback — and a cookie scoped to `.localtest.me` is never
 * sent to `localhost`, which makes every authenticated call a spurious 401.
 */
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

/** Sign up a fresh workspace; returns its slug and tenant base URL. */
async function createWorkspace(page: import("@playwright/test").Page, tag: string) {
  const uniq = Date.now();
  const slug = `test-rbac${tag}${uniq}`.replace(/[^a-z0-9-]/g, "");
  const email = `test-rbac${tag}${uniq}@example.com`;

  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill("PW RBAC");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Password123!");
  await page.getByLabel("Workspace name").fill(slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });

  return { slug, email, base: `http://${slug}.localtest.me:3000` };
}

test.describe("RBAC permission gating", () => {
  test("owner's permission set drives the rendered controls", async ({ page }) => {
    const { slug, base } = await createWorkspace(page, "own");

    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");

    // /me carries the computed set the UI gates on. Asserted unconditionally —
    // a failed fetch must fail the test, not skip it.
    const me = await fetchMe(page, slug);

    expect(me.status).toBe(200);
    expect(me.body.role).toBe("owner");
    expect(me.body.permissions.staff).toContain("invite");
    expect(me.body.permissions.tenant).toContain("transfer-ownership");
    expect(me.body.permissions.billing).toContain("manage");
    // The app vocabulary only — Better Auth's internal statements must not ship.
    expect(me.body.permissions.organization).toBeUndefined();
    expect(me.body.permissions.member).toBeUndefined();

    // staff:invite is held, so the invite form renders with the enabled copy.
    await expect(page.getByPlaceholder("teammate@example.com")).toBeVisible();
    await expect(
      page.getByText(/invite a teammate to this workspace/i),
    ).toBeVisible();
    await expect(
      page.getByText(/you don't have permission to invite teammates/i),
    ).toHaveCount(0);
  });

  test("another tenant's dashboard does not render its members UI", async ({
    page,
  }) => {
    const a = await createWorkspace(page, "a");
    // Signing up B replaces the session; A's dashboard must no longer be reachable.
    const b = await createWorkspace(page, "b");
    expect(b.slug).not.toBe(a.slug);

    await page.goto(`${a.base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");

    // The gated control must not render for a non-member of tenant A, and the
    // API must refuse the cross-tenant read outright.
    await expect(page.getByPlaceholder("teammate@example.com")).toHaveCount(0);

    // Refused either way: 403 when the session is seen and the user is not a
    // member of tenant A, 401 when the tenant host rejects it before that. What
    // must never happen is a 200.
    const cross = await fetchMe(page, a.slug);
    expect([401, 403]).toContain(cross.status);
    expect(cross.body).toBeNull();
  });
});
