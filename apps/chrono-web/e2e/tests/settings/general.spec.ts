import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the tenant self-service General settings page: rename
 * the business, see it persist, and confirm the change never leaks across
 * tenants.
 *
 * The role gate (a non-owner denied `tenant:update`) is proven at the API
 * level (`pnpm test:e2e` → `apps/chrono-api/src/e2e/run.ts`, section "U1"),
 * exactly like the `tenant/suspend` owner-only precedent it mirrors — this
 * suite always signs up a fresh business, which is always `owner`
 * (`.ai/rules/e2e-testing.md`'s own documented split, see
 * `apps/chrono-web/e2e/tests/settings/members-invite.spec.ts`'s header
 * comment). A test that can only ever be owner cannot demonstrate denial.
 */

/** Call the RPC organization endpoint from inside the page (session cookie attached). */
async function fetchOrganization(
  page: import("@playwright/test").Page,
  tenantSlug: string,
): Promise<{ status: number; body: any }> {
  return page.evaluate(async (slug) => {
    const api = location.origin.replace(/:3000$/, ":8787");
    const res = await fetch(`${api}/rpc/organization`, {
      credentials: "include",
      headers: { "x-tenant-slug": slug },
    });
    return { status: res.status, body: res.ok ? await res.json() : null };
  }, tenantSlug);
}

/** Sign up a fresh business; returns its slug and tenant base URL. */
async function createBusiness(page: import("@playwright/test").Page, tag: string) {
  const uniq = Date.now();
  const slug = `test-gen${tag}${uniq}`.replace(/[^a-z0-9-]/g, "");
  const email = `test-gen${tag}${uniq}@example.com`;

  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill("PW General");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill("Password123!");
  await page.getByLabel("Business name").fill(`PW General ${tag}`);
  await page.getByLabel("Business URL").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });

  return { slug, email, base: `http://${slug}.localtest.me:3000` };
}

test.describe("General settings", () => {
  test("owner renames the business and the change persists across reload", async ({
    page,
  }) => {
    const { slug, base } = await createBusiness(page, "own");

    await page.goto(`${base}/admin/settings/general`);
    await page.waitForLoadState("networkidle");

    const nameInput = page.getByLabel("Business name");
    await expect(nameInput).not.toHaveValue("");

    const renamed = `Renamed Business ${Date.now()}`;
    await nameInput.fill(renamed);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Business name updated.")).toBeVisible();

    // Reload — the saved name must come back from the server, not local state.
    await page.goto(`${base}/admin/settings/general`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByLabel("Business name")).toHaveValue(renamed);

    // The API agrees.
    const fetched = await fetchOrganization(page, slug);
    expect(fetched.status).toBe(200);
    expect(fetched.body.organization.name).toBe(renamed);
    expect(fetched.body.organization.slug).toBe(slug);
  });

  test("renaming one business never touches another's name", async ({ page }) => {
    const a = await createBusiness(page, "a");
    await page.goto(`${a.base}/admin/settings/general`);
    await page.waitForLoadState("networkidle");
    const renamedA = `Tenant A Renamed ${Date.now()}`;
    await page.getByLabel("Business name").fill(renamedA);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Business name updated.")).toBeVisible();

    // Signing up B replaces the session; A's dashboard is no longer reachable
    // from this browser context.
    const b = await createBusiness(page, "b");
    expect(b.slug).not.toBe(a.slug);

    // B's own organization is unaffected by A's rename.
    const bOrg = await fetchOrganization(page, b.slug);
    expect(bOrg.status).toBe(200);
    expect(bOrg.body.organization.name).not.toBe(renamedA);

    // B's session cannot read A's organization at all.
    const crossRead = await fetchOrganization(page, a.slug);
    expect([401, 403]).toContain(crossRead.status);
    expect(crossRead.body).toBeNull();
  });
});
