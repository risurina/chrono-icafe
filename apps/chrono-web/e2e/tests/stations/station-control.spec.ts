import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the Station Control board (chrono/stations).
 *
 * Per Phase 4 of
 * .ai/plans/chrono/active/station-control-grouping/README.md:
 * - Happy path: sign up, create a branch, two station groups (one used, one
 *   left empty for the ungrouped station), three stations (two grouped, one
 *   unassigned), top up a portal member's wallet, land on the Station
 *   Control board by default, confirm the group headers and a station number
 *   render, then start/pause/add-time/end a session entirely from the card.
 * - Role gate: a portal member's session cannot call the board's staff-only
 *   read route.
 * - Tenant isolation: tenant B's board never shows tenant A's stations, and a
 *   direct cross-tenant board read returns an empty station list.
 *
 * Transfer (Phase 2 of the plan) is deliberately NOT covered here — it was
 * deferred by developer decision and is not implemented in this pass.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const SEEDED_PASSWORD = "Password123!";

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
    waitUntil: "commit",
  });
}

async function portalSignUp(
  page: import("@playwright/test").Page,
  base: string,
  { name, email }: { name: string; email: string },
) {
  await page.goto(`${base}/portal/sign-up`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(`${base}/member`, { timeout: 15_000 });
}

// Every direct `page.request` call below must carry `x-tenant-slug` — unlike
// the browser's own RPC client (which derives it from `window.location.host`
// via `tenantFetch()`), a raw `page.request` call has no tenant context of
// its own, and the API's `tenantMiddleware()` requires an explicit
// `x-tenant-slug`/`x-tenant-host` header with no Host-header fallback
// (confirmed directly: an unheadered call 404s "Unknown tenant" even with a
// valid session cookie). This is a pre-existing, repo-wide gap in several
// e2e helper functions (this file's own convention, copied from
// sessions.spec.ts/stations.spec.ts) — unrelated to station-control-grouping,
// but fixed here so this spec's own assertions are real.
async function findMemberId(
  page: import("@playwright/test").Page,
  slug: string,
  email: string,
): Promise<string> {
  // `/rpc/members` lists STAFF org membership (`base.member` + `base.user`) —
  // wrong table entirely for a portal customer. `/rpc/customers` is the
  // `tenantMember`-backed route this helper actually needs (confirmed
  // against apps/chrono-api/src/routes/rpc.ts) — a pre-existing wrong-
  // endpoint bug in this repo's copied test-helper convention
  // (sessions.spec.ts's own `findMemberId` has the same mistake), unrelated
  // to station-control-grouping.
  const res = await page.request.get(`${API_URL}/rpc/customers`, {
    params: { pageSize: "100" },
    headers: { "x-tenant-slug": slug },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; email: string }[] };
  // The API normalizes stored emails to lowercase; the faker-generated
  // `email` here keeps its original mixed case, so this must compare
  // case-insensitively or a real row is never matched.
  const wanted = email.toLowerCase();
  const member = body.items.find((m) => m.email.toLowerCase() === wanted);
  expect(member).toBeDefined();
  return member!.id;
}

async function topUpWallet(
  page: import("@playwright/test").Page,
  slug: string,
  memberId: string,
  amount: string,
): Promise<void> {
  const res = await page.request.post(`${API_URL}/rpc/wallets/${memberId}/credit`, {
    data: { amount },
    headers: { "x-tenant-slug": slug },
  });
  expect(res.ok()).toBeTruthy();
}

/** Look up a branch's id from the tenant-scoped list. */
async function findBranchId(
  page: import("@playwright/test").Page,
  slug: string,
  name: string,
): Promise<string> {
  const res = await page.request.get(`${API_URL}/rpc/branches`, {
    params: { pageSize: "100" },
    headers: { "x-tenant-slug": slug },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; name: string }[] };
  const branch = body.items.find((b) => b.name === name);
  expect(branch).toBeTruthy();
  return branch!.id;
}

/**
 * Creates a branch, a "VIP" station group, two stations in it, and one
 * ungrouped station, via the real dashboard UI (the "Manage Stations" CRUD
 * tab). Returns the identifiers this spec asserts on.
 */
async function setupBoardFixture(
  page: import("@playwright/test").Page,
  base: string,
  uniq: string,
): Promise<{
  branchId: string;
  groupLabel: string;
  vip1Number: string;
  vip2Number: string;
  ungroupedNumber: string;
}> {
  const slug = new URL(base).hostname.split(".")[0]!;
  const branchName = `Branch ${uniq}`;
  const groupName = `VIP ${uniq}`;
  const vip1Number = `V1${uniq}`.slice(0, 12);
  const vip2Number = `V2${uniq}`.slice(0, 12);
  const ungroupedNumber = `U1${uniq}`.slice(0, 12);

  await page.goto(`${base}/admin/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(branchName);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(branchName)).toBeVisible();
  const branchId = await findBranchId(page, slug, branchName);

  await page.goto(`${base}/admin/stations`);
  await page.waitForLoadState("networkidle");
  // "Station Control" is the new default tab — switch to the CRUD tab this
  // fixture setup actually exercises.
  await page.getByRole("tab", { name: "Manage Stations" }).click();

  await page.getByRole("tab", { name: "Groups & Rates" }).click();
  await page.getByRole("button", { name: "Add Group" }).click();
  await page.getByLabel("Name *").fill(groupName);
  await page.getByLabel("Code *").fill(`G${uniq}`.slice(0, 12));
  await page.getByLabel("Hourly Rate ($) *").fill("10.00");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByText("Group created.")).toBeVisible();

  await page.getByRole("tab", { name: "Manage Stations" }).click();

  async function addStation(number: string, name: string, group?: string) {
    await page.getByRole("button", { name: "Add Station" }).click();
    await page.getByLabel("Number *").fill(number);
    await page.getByLabel("Name *").fill(name);
    if (group) {
      // The trigger's accessible name comes from its associated
      // <Label htmlFor="s-group">Group</Label>, not its displayed value
      // ("None") — a pre-existing characteristic of this Select/Label
      // pairing (confirmed via direct inspection), unrelated to grouping.
      await page.getByRole("combobox", { name: "Group" }).click();
      await page.getByRole("option", { name: group }).click();
    }
    await page.getByRole("button", { name: "Create station" }).click();
    await expect(page.getByText("Station created.")).toBeVisible();
  }

  await addStation(vip1Number, `Station ${vip1Number}`, groupName);
  await addStation(vip2Number, `Station ${vip2Number}`, groupName);
  await addStation(ungroupedNumber, `Station ${ungroupedNumber}`);

  return { branchId, groupLabel: groupName, vip1Number, vip2Number, ungroupedNumber };
}

test.describe("Station Control board", () => {
  test("happy path: grouped board renders, start/pause/add-time/end from the card", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(6).toLowerCase();
    const slug = `e2esctl${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Board Owner", email: ownerEmail, slug });

    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: customerName, email: customerEmail });
    await ctxCust.close();

    const { groupLabel, vip1Number, ungroupedNumber } = await setupBoardFixture(
      page,
      base,
      uniq,
    );

    const memberId = await findMemberId(page, slug, customerEmail);
    await topUpWallet(page, slug, memberId, "50.00");

    // Land back on Station Control (the default tab) with a fresh load.
    await page.goto(`${base}/admin/stations`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText(`${groupLabel} — 2 Stations`)).toBeVisible();
    await expect(page.getByText("Unassigned Stations — 1 Station")).toBeVisible();
    // `exact: true` — the station name is "Station <number>", a superset
    // substring match of the bare number, so a non-exact query resolves to
    // both the number and the name elements (strict-mode violation).
    await expect(page.getByText(vip1Number, { exact: true })).toBeVisible();
    await expect(page.getByText(ungroupedNumber, { exact: true })).toBeVisible();

    // Start a session on the first VIP station directly from its card.
    const vip1Card = page.getByTestId(new RegExp("station-board-card-")).filter({
      hasText: vip1Number,
    });
    await vip1Card.getByRole("button", { name: "Start" }).click();
    await page.getByLabel("Member ID").fill(memberId);
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page.getByText("Session started.")).toBeVisible();

    // Card now shows the member's name, a live-ticking timer, and switches to
    // the occupied action set.
    await expect(vip1Card.getByText(customerName)).toBeVisible({ timeout: 15_000 });
    await expect(vip1Card.getByText(/^\d{2}:\d{2}:\d{2}$/)).toBeVisible();
    await expect(vip1Card.getByRole("button", { name: "Pause" })).toBeVisible();

    await vip1Card.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Session paused.")).toBeVisible();
    await expect(vip1Card.getByRole("button", { name: "Resume" })).toBeVisible();

    await vip1Card.getByRole("button", { name: "Add Time" }).click();
    await page.getByLabel("Minutes to add").fill("15");
    await page.getByRole("button", { name: "Add time" }).click();
    await expect(page.getByText("Session extended.")).toBeVisible();

    await vip1Card.getByRole("button", { name: "End" }).click();
    await page.getByRole("button", { name: "End session" }).click();
    await expect(page.getByText("Session ended.")).toBeVisible();

    // Card returns to available with no customer name or timer, and a Start
    // button is available again.
    await expect(vip1Card.getByText(customerName)).toHaveCount(0);
    await expect(vip1Card.getByRole("button", { name: "Start" })).toBeVisible();
  });

  test("role gate: a portal member's session is refused on the staff-only board read", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(6).toLowerCase();
    const slug = `e2esctlgate${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Board Owner", email: ownerEmail, slug });

    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: customerName, email: customerEmail });

    const { branchId } = await setupBoardFixture(page, base, uniq);

    const crossRes = await pageCust.request.get(`${API_URL}/rpc/stations/board`, {
      params: { branchId },
      headers: { "x-tenant-slug": slug },
    });
    expect([401, 403]).toContain(crossRes.status());

    await ctxCust.close();
  });

  test("tenant isolation: tenant B never sees tenant A's stations, and a direct cross-tenant board read is empty", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(6).toLowerCase();
    const slugA = `e2esctla${uniq}`;
    const slugB = `e2esctlb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });
    const { branchId: branchIdA, vip1Number, groupLabel } = await setupBoardFixture(
      page,
      baseA,
      uniq,
    );

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });

    await pageB.goto(`${baseB}/admin/stations`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(vip1Number)).toHaveCount(0);
    await expect(pageB.getByText(groupLabel)).toHaveCount(0);

    // Direct cross-tenant board read: RLS-scoped, so a wrong-tenant session
    // gets an empty station list, not a leak or a 404 (branchId ownership is
    // not itself validated on this read path — matches this module's
    // existing "empty, not 404" convention for a branchId filter).
    const crossRes = await pageB.request.get(`${API_URL}/rpc/stations/board`, {
      params: { branchId: branchIdA },
      headers: { "x-tenant-slug": slugB },
    });
    expect(crossRes.ok()).toBeTruthy();
    const crossBody = (await crossRes.json()) as { stations: unknown[] };
    expect(crossBody.stations).toEqual([]);

    await ctxB.close();
  });
});
