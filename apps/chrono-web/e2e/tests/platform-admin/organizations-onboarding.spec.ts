import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Browser coverage for Chrono's onboarding checklist surfaced on the platform
 * admin Organizations pages
 * (`.ai/plans/chrono/active/platform-admin-onboarding-progress/README.md`,
 * Phase 3).
 *
 * Builds its own two throwaway tenants at runtime rather than relying on the
 * shared seed: the shared seed's `gaming`/`acme` land at an identical 4/7 and
 * `contoso`/`globex` at an identical 0/7, so comparing one seeded tenant
 * against another proves nothing about whether the registry is actually
 * wired up (this plan's round-1 audit finding).
 *
 * Fixture-determinism note (this plan's Pass 1):
 * `signup-default-provisioning.spec.ts` auto-provisions a "Main" branch +
 * Regular/Premium/VIP station groups on a fresh tenant's first `/admin`
 * load, so BOTH tenants below settle at a small non-zero fraction before
 * either does anything themselves. This spec never asserts a literal
 * starting number — it polls until two consecutive reads agree, then
 * diverges tenant A's fraction from tenant B's via real dashboard actions.
 */

const SEEDED_PASSWORD = "Password123!";
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEARCH_PLACEHOLDER = "Search name or slug…";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

/**
 * Reused verbatim from `onboarding-checklist.spec.ts` (lines 50-64) —
 * account creation only. That spec's "both start at 0/7" (lines 226-230)
 * and "completedCount===1 after one branch" (line 242) assertions are
 * deliberately NOT carried over: both assume a freshness this plan's own
 * Pass 1 flags as unsafe, since auto-provisioning settles a fresh tenant at
 * a non-zero fraction, not 0/7.
 */
async function signUp(
  page: Page,
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

type ChecklistItemState = { key: string; label: string; stage: string; done: boolean };
type ChecklistState = {
  items: ChecklistItemState[];
  completedCount: number;
  total: number;
};

/**
 * Reads the tenant-facing checklist state directly from the API (never the
 * web origin — this app has no `/api/rpc/*` proxy route; the real browser
 * client, `lib/rpc.ts`, calls `NEXT_PUBLIC_API_URL` directly and derives
 * `x-tenant-slug` from the current host, mirrored here). Runs through
 * `page.request`, so it shares the signed-in owner's session cookie from the
 * same browser context — a real authenticated call, not a direct DB read.
 */
async function getChecklist(page: Page, slug: string): Promise<ChecklistState> {
  const res = await page.request.get(`${API_URL}/rpc/onboarding/checklist`, {
    headers: { "x-tenant-slug": slug },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as ChecklistState;
}

/**
 * Poll until two consecutive reads agree, rather than asserting any literal
 * starting fraction — fire-and-forget branch/station-group auto-provisioning
 * races the very first read after sign-up (Pass 1's fixture-determinism
 * note). Mirrors `signup-default-provisioning.spec.ts`'s own
 * poll-until-it-lands pattern: the very first read can catch 0/7 before that
 * fire-and-forget call has landed at all, which a naive "two consecutive
 * equal reads" check would wrongly treat as already settled — so this first
 * waits for *some* completion (never a literal count) before polling for
 * stability.
 */
async function waitForSettled(page: Page, slug: string): Promise<ChecklistState> {
  await expect
    .poll(async () => (await getChecklist(page, slug)).completedCount, { timeout: 15_000 })
    .toBeGreaterThan(0);

  let prevKey: string | null = null;
  let last: ChecklistState | null = null;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const state = await getChecklist(page, slug);
    const key = JSON.stringify(state.items.map((i) => [i.key, i.done]));
    if (key === prevKey) return state;
    prevKey = key;
    last = state;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (last) return last;
  throw new Error(`Checklist for ${slug} never returned any state`);
}

/** Drives the real "Add Station" dialog on /admin/stations. */
async function addStation(
  page: Page,
  base: string,
  opts: { number: string; name: string; groupName: string },
) {
  await page.goto(`${base}/admin/stations`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Manage Stations" }).click();
  await page.getByRole("button", { name: "Add Station" }).click();
  await page.getByLabel("Number *").fill(opts.number);
  await page.getByLabel("Name *").fill(opts.name);
  await page.getByRole("combobox", { name: "Group" }).click();
  await page.getByRole("option", { name: opts.groupName }).click();
  await page.getByRole("button", { name: "Create station" }).click();
  await expect(page.getByText("Station created.")).toBeVisible();
}

/** Drives the real "Add product" dialog on /admin/pos/products. */
async function addProduct(page: Page, base: string, opts: { name: string; price: string }) {
  await page.goto(`${base}/admin/pos/products`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add product" }).click();
  await page.getByLabel("Name").fill(opts.name);
  await page.getByLabel("Price").fill(opts.price);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Product created.")).toBeVisible();
}

/** Drives the real crew-invite flow — a pending invitation alone flips
 * `inviteStaff` to done (contracts.ts's probe: memberCount>1 OR a pending
 * invitation), so accepting it is unnecessary for this spec's purposes. */
async function inviteCrew(page: Page, base: string, email: string) {
  await page.goto(`${base}/admin/settings/crew`);
  await page.waitForLoadState("networkidle");
  await page.getByPlaceholder("teammate@example.com").fill(email);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Invite crew" }).click();
  await expect(page.getByText(email)).toBeVisible();
}

async function signInStaff(page: Page, host: string, email: string) {
  await page.goto(`http://${host}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 15_000 });
}

/** Open the admin organizations list and search for a slug, returning its row. */
async function findOrgRow(adminPage: Page, slug: string) {
  await adminPage.goto("http://localtest.me:3000/admin/organizations");
  await adminPage.waitForLoadState("networkidle");
  await adminPage.getByPlaceholder(SEARCH_PLACEHOLDER).fill(slug);
  const row = adminPage.getByRole("row").filter({ hasText: slug });
  await expect(row).toBeVisible();
  return row;
}

test.describe("Platform admin Organizations — onboarding checklist (Chrono)", () => {
  test("shows each tenant's real, distinct onboarding fraction and per-item state, isolated across tenants", async ({
    page,
    browser,
  }) => {
    test.setTimeout(150_000);

    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `onba${uniq}`;
    const slugB = `onbb${uniq}`;
    const baseA = `http://${slugA}.localtest.me:3000`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });

    // Tenant B: sign up, let auto-provisioning settle, do nothing further —
    // this is the low fraction tenant A's driven steps must exceed.
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    await signUp(pageB, { name: "Onboard B Owner", email: emailB, slug: slugB });
    const settledB = await waitForSettled(pageB, slugB);

    // Tenant A: sign up, let auto-provisioning settle, then drive two REAL
    // extra onboarding steps through the actual dashboard (never a direct DB
    // write) — a station and a POS product. `inviteStaff` is deliberately
    // left untouched here; step 5 below flips it specifically to prove
    // cross-tenant isolation on the one item Phase 0's fix touches.
    await signUp(page, { name: "Onboard A Owner", email: emailA, slug: slugA });
    const settledA = await waitForSettled(page, slugA);

    await addStation(page, baseA, {
      number: faker.string.numeric(3),
      name: "Onboarding Test Station",
      groupName: "Regular",
    });
    await addProduct(page, baseA, {
      name: `Onboarding Snack ${uniq}`,
      price: "2.50",
    });

    const afterExtrasA = await waitForSettled(page, slugA);

    // Steps 1-2 acceptance: both settled at a real, non-zero fraction — no
    // literal number asserted; A's driven fraction strictly exceeds B's;
    // the two done-sets overlap (both completed the auto-provisioned steps)
    // but are not identical (A has strictly more).
    expect(settledA.total).toBe(7);
    expect(settledB.total).toBe(7);
    expect(settledA.completedCount).toBeGreaterThan(0);
    expect(settledB.completedCount).toBeGreaterThan(0);
    expect(afterExtrasA.completedCount).toBeGreaterThan(settledB.completedCount);
    expect(afterExtrasA.completedCount).not.toBe(settledB.completedCount);

    const doneKeysA = new Set(afterExtrasA.items.filter((i) => i.done).map((i) => i.key));
    const doneKeysB = new Set(settledB.items.filter((i) => i.done).map((i) => i.key));
    const overlap = [...doneKeysA].filter((k) => doneKeysB.has(k));
    expect(overlap.length).toBeGreaterThan(0);
    expect(doneKeysA).not.toEqual(doneKeysB);
    // Neither tenant has touched inviteStaff yet — the isolation check below
    // needs this to still be false on both sides beforehand.
    expect(afterExtrasA.items.find((i) => i.key === "inviteStaff")?.done).toBe(false);
    expect(settledB.items.find((i) => i.key === "inviteStaff")?.done).toBe(false);

    // Platform admin view.
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);

    // Step 3: list row fractions match each tenant's own real state, and
    // are visibly different from each other.
    const rowA = await findOrgRow(adminPage, slugA);
    await expect(rowA.getByTestId("org-onboarding")).toHaveText(
      `${afterExtrasA.completedCount}/${afterExtrasA.total}`,
    );
    const rowB = await findOrgRow(adminPage, slugB);
    await expect(rowB.getByTestId("org-onboarding")).toHaveText(
      `${settledB.completedCount}/${settledB.total}`,
    );

    // Resolve each tenant's org id via the same authenticated admin session
    // (never a direct DB read) to reach its detail page.
    async function orgIdFor(slug: string): Promise<string> {
      const res = await adminPage.request.get(
        `${API_URL}/rpc-admin/organizations?q=${slug}&pageSize=5`,
      );
      expect(res.ok()).toBeTruthy();
      const body = (await res.json()) as { items: { id: string; slug: string }[] };
      const row = body.items.find((o) => o.slug === slug);
      if (!row) throw new Error(`Org ${slug} not found in admin list`);
      return row.id;
    }
    const orgIdA = await orgIdFor(slugA);
    const orgIdB = await orgIdFor(slugB);

    // Step 4: the detail page's checklist card is visible and lists every
    // item label; the per-item done state (verified against the SAME
    // authenticated route the card itself renders from) matches what was
    // actually driven above, and the two tenants' done sets differ.
    await adminPage.goto(`http://localtest.me:3000/admin/organizations/${orgIdA}`);
    await adminPage.waitForLoadState("networkidle");
    const checklistCardA = adminPage.getByTestId("org-onboarding-checklist");
    await expect(checklistCardA).toBeVisible();
    for (const item of afterExtrasA.items) {
      await expect(checklistCardA.getByText(item.label, { exact: true })).toBeVisible();
    }

    const detailResA = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${orgIdA}`,
    );
    const detailBodyA = (await detailResA.json()) as {
      onboarding: { completedCount: number; total: number; items: ChecklistItemState[] };
    };
    expect(detailBodyA.onboarding.total).toBe(7);
    expect(detailBodyA.onboarding.completedCount).toBe(afterExtrasA.completedCount);
    for (const item of afterExtrasA.items) {
      const detailItem = detailBodyA.onboarding.items.find((i) => i.key === item.key);
      expect(detailItem?.done).toBe(item.done);
    }

    const detailResB = await adminPage.request.get(
      `${API_URL}/rpc-admin/organizations/${orgIdB}`,
    );
    const detailBodyB = (await detailResB.json()) as {
      onboarding: { completedCount: number; total: number; items: ChecklistItemState[] };
    };
    expect(detailBodyB.onboarding.total).toBe(7);
    expect(detailBodyB.onboarding.completedCount).toBe(settledB.completedCount);

    const detailDoneA = new Set(
      detailBodyA.onboarding.items.filter((i) => i.done).map((i) => i.key),
    );
    const detailDoneB = new Set(
      detailBodyB.onboarding.items.filter((i) => i.done).map((i) => i.key),
    );
    expect(detailDoneA).not.toEqual(detailDoneB);

    // Step 5: give tenant A a second staff member — flips inviteStaff to
    // done for A only. This is the specific item Phase 0's connection-nesting
    // fix touches, so it is the one most worth a direct, concrete isolation
    // assertion.
    const staffEmailA = faker.internet.email({ provider: "example.com" });
    await inviteCrew(page, baseA, staffEmailA);

    const afterInviteA = await waitForSettled(page, slugA);
    expect(afterInviteA.items.find((i) => i.key === "inviteStaff")?.done).toBe(true);
    expect(afterInviteA.completedCount).toBe(afterExtrasA.completedCount + 1);

    const afterInviteB = await getChecklist(pageB, slugB);
    expect(afterInviteB.items.find((i) => i.key === "inviteStaff")?.done).toBe(false);
    expect(afterInviteB.completedCount).toBe(settledB.completedCount);

    // The platform admin list reflects this immediately, isolated per tenant.
    const rowAAfterInvite = await findOrgRow(adminPage, slugA);
    await expect(rowAAfterInvite.getByTestId("org-onboarding")).toHaveText(
      `${afterInviteA.completedCount}/${afterInviteA.total}`,
    );
    const rowBAfterInvite = await findOrgRow(adminPage, slugB);
    await expect(rowBAfterInvite.getByTestId("org-onboarding")).toHaveText(
      `${afterInviteB.completedCount}/${afterInviteB.total}`,
    );

    await contextB.close();
    await adminContext.close();
  });
});
