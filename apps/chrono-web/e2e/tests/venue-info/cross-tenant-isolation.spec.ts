import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * `GET /public/venue-info` — the mandatory tenant-isolation proof for the one
 * new backend read in `.ai/plans/chrono/in-progress/tenant-white-label-site`.
 *
 * The route is unauthenticated and resolves its tenant from the request host
 * (never client input), then reads through `withTenant`. This spec drives it
 * anonymously against two real, separately-seeded tenants and asserts each host
 * sees only its own branch and rate groups — the browser-level counterpart to
 * `rls:proof`.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const SEEDED_PASSWORD = "Password123!";

type VenueInfo = {
  branch: {
    name: string;
    address: string | null;
    googleMapsUrl: string | null;
    operatingHours: string | null;
    contactNumber: string | null;
    email: string | null;
    socialLinks: Record<string, string | null | undefined> | null;
    hoursConfig: unknown;
    openStatus: { isOpen: boolean; opensAt: string | null } | null;
  } | null;
  rateGroups: { id: string; name: string; hourlyRate: string; memberRate: string | null }[];
};

async function signUp(
  page: import("@playwright/test").Page,
  { name, email, slug }: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });
}

/** Create a branch through the real dashboard UI, then fill in its public fields. */
async function createBranch(
  page: import("@playwright/test").Page,
  base: string,
  name: string,
): Promise<string> {
  await page.goto(`${base}/admin/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(name)).toBeVisible();

  const res = await page.request.get(`${API_URL}/rpc/branches`, {
    params: { pageSize: "100" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; name: string }[] };
  const branch = body.items.find((b) => b.name === name);
  expect(branch).toBeTruthy();
  return branch!.id;
}

test.describe("Public venue info — cross-tenant isolation", () => {
  test("each host sees only its own branch and rate groups", async ({ page, browser }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2evenuea${uniq}`;
    const slugB = `e2evenueb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    // Distinct, unmistakable values per tenant, so a leak is unambiguous.
    const branchNameA = `test-branch-a-${uniq}`;
    const branchNameB = `test-branch-b-${uniq}`;
    const addressA = `test-address-a-${uniq}`;
    const addressB = `test-address-b-${uniq}`;
    const phoneA = "0917-000-0001";
    const phoneB = "0917-000-0002";
    const groupNameA = `test-group-a-${uniq}`;
    const groupNameB = `test-group-b-${uniq}`;
    const facebookA = `https://facebook.com/test-a-${uniq}`;
    const facebookB = `https://facebook.com/test-b-${uniq}`;

    // ── Tenant A ────────────────────────────────────────────────────────────
    await signUp(page, { name: "Venue A", email: emailA, slug: slugA });
    const branchIdA = await createBranch(page, baseA, branchNameA);

    const patchA = await page.request.patch(`${API_URL}/rpc/branches/${branchIdA}`, {
      data: {
        address: addressA,
        contactNumber: phoneA,
        email: `a-${uniq}@example.com`,
        operatingHours: "10:00 - 22:00",
        socialLinks: { facebook: facebookA },
      },
    });
    expect(patchA.ok()).toBeTruthy();

    const groupA = await page.request.post(`${API_URL}/rpc/stations/groups`, {
      data: {
        branchId: branchIdA,
        name: groupNameA,
        code: `GA${uniq.slice(0, 4)}`,
        hourlyRate: 75,
        memberRate: 60,
      },
    });
    expect(groupA.ok()).toBeTruthy();

    // ── Tenant B (its own context, so it has its own session) ───────────────
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Venue B", email: emailB, slug: slugB });
    const branchIdB = await createBranch(pageB, baseB, branchNameB);

    const patchB = await pageB.request.patch(`${API_URL}/rpc/branches/${branchIdB}`, {
      data: {
        address: addressB,
        contactNumber: phoneB,
        email: `b-${uniq}@example.com`,
        operatingHours: "12:00 - 02:00",
        socialLinks: { facebook: facebookB },
      },
    });
    expect(patchB.ok()).toBeTruthy();

    const groupB = await pageB.request.post(`${API_URL}/rpc/stations/groups`, {
      data: {
        branchId: branchIdB,
        name: groupNameB,
        code: `GB${uniq.slice(0, 4)}`,
        hourlyRate: 120,
      },
    });
    expect(groupB.ok()).toBeTruthy();
    await ctxB.close();

    // The route is public — prove it needs no session at all.
    await page.context().clearCookies();

    // ── Tenant A's host returns ONLY tenant A's data ────────────────────────
    const resA = await page.request.get(`${API_URL}/public/venue-info`, {
      headers: { "x-tenant-slug": slugA },
    });
    expect(resA.status()).toBe(200);
    const bodyA = (await resA.json()) as VenueInfo;

    expect(bodyA.branch?.name).toBe(branchNameA);
    expect(bodyA.branch?.address).toBe(addressA);
    expect(bodyA.branch?.contactNumber).toBe(phoneA);
    expect(bodyA.branch?.socialLinks?.facebook).toBe(facebookA);
    expect(bodyA.rateGroups.map((g) => g.name)).toEqual([groupNameA]);
    expect(Number(bodyA.rateGroups[0]!.hourlyRate)).toBe(75);

    // ...and none of tenant B's, anywhere in the payload.
    const serializedA = JSON.stringify(bodyA);
    expect(serializedA).not.toContain(branchNameB);
    expect(serializedA).not.toContain(addressB);
    expect(serializedA).not.toContain(phoneB);
    expect(serializedA).not.toContain(groupNameB);
    expect(serializedA).not.toContain(facebookB);

    // No raw row leakage: the response carries the allowlisted columns only.
    expect(Object.keys(bodyA).sort()).toEqual(["branch", "rateGroups"]);
    expect(Object.keys(bodyA.branch!).sort()).toEqual([
      "address",
      "contactNumber",
      "email",
      "googleMapsUrl",
      "hoursConfig",
      "name",
      "openStatus",
      "operatingHours",
      "socialLinks",
    ]);
    expect(serializedA).not.toContain("tenantId");

    // ── Tenant B's host returns ONLY tenant B's data ────────────────────────
    const resB = await page.request.get(`${API_URL}/public/venue-info`, {
      headers: { "x-tenant-slug": slugB },
    });
    expect(resB.status()).toBe(200);
    const bodyB = (await resB.json()) as VenueInfo;

    expect(bodyB.branch?.name).toBe(branchNameB);
    expect(bodyB.branch?.address).toBe(addressB);
    expect(bodyB.rateGroups.map((g) => g.name)).toEqual([groupNameB]);
    expect(Number(bodyB.rateGroups[0]!.hourlyRate)).toBe(120);

    const serializedB = JSON.stringify(bodyB);
    expect(serializedB).not.toContain(branchNameA);
    expect(serializedB).not.toContain(addressA);
    expect(serializedB).not.toContain(phoneA);
    expect(serializedB).not.toContain(groupNameA);
    expect(serializedB).not.toContain(facebookA);

    // ── An unresolvable host is a 404, not an empty 200 ─────────────────────
    const resUnknown = await page.request.get(`${API_URL}/public/venue-info`, {
      headers: { "x-tenant-slug": `e2eunknown${uniq}` },
    });
    expect(resUnknown.status()).toBe(404);
  });

  test("a tenant with no active branch is a normal 200, never a 404", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2evenueempty${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });

    // Signed up but never onboarded — no branch exists yet.
    await signUp(page, { name: "Venue Empty", email, slug });
    await page.context().clearCookies();

    const res = await page.request.get(`${API_URL}/public/venue-info`, {
      headers: { "x-tenant-slug": slug },
    });
    expect(res.status()).toBe(200);

    const body = (await res.json()) as VenueInfo;
    expect(body.branch).toBeNull();
    expect(body.rateGroups).toEqual([]);
  });
});
