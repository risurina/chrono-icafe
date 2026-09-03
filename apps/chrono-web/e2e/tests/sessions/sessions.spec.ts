import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the Sessions module (chrono/sessions).
 *
 * Per Phase 6 of .ai/plans/chrono/active/sessions/README.md:
 * - Happy path: sign up a tenant + a customer, create a branch/station/group,
 *   top up the customer's wallet, start a session, confirm the station is
 *   occupied and a second start 409s, pause (assert pausedAt via API),
 *   resume, end early (wallet balance decreases, station becomes available),
 *   confirm the customer's /portal no longer shows a current session.
 * - Role gate (portal-vs-staff, not staff-vs-admin — sessions has no
 *   staff-denial case by design): a customer's portal session cannot call
 *   staff /rpc/sessions/* routes; a staff session can start/pause/resume/
 *   extend/end without any 403.
 * - Tenant isolation: tenant A's session never appears in tenant B's list,
 *   and a direct cross-tenant sessionId lifecycle call 404s.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";
const SEEDED_PASSWORD = "Password123!";

async function findInviteLink(toEmail: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  const pattern = new RegExp(
    `\\[email:console\\] to=${toEmail.replace(/[.+]/g, "\\$&")}.*?link=(\\S+)`,
  );
  while (Date.now() < deadline) {
    const log = readFileSync(DEV_LOG_PATH, "utf8");
    const match = log.match(pattern);
    if (match?.[1]) return match[1];
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No console-driver invite link found for ${toEmail} in ${DEV_LOG_PATH}`);
}

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
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
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
  await page.waitForURL(`${base}/portal`, { timeout: 15_000 });
}

/** Creates a branch + station-group + station via the real dashboard UI,
 * returns the new station's id (looked up via the API afterward). */
async function createBranchStationAndGroup(
  page: import("@playwright/test").Page,
  base: string,
  {
    branchName,
    groupName,
    groupCode,
    stationNumber,
    stationName,
  }: {
    branchName: string;
    groupName: string;
    groupCode: string;
    stationNumber: string;
    stationName: string;
  },
): Promise<string> {
  await page.goto(`${base}/dashboard/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(branchName);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(branchName)).toBeVisible();

  await page.goto(`${base}/dashboard/stations`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Groups & Rates" }).click();
  await page.getByRole("button", { name: "Add Group" }).click();
  await page.getByLabel("Name *").fill(groupName);
  await page.getByLabel("Code *").fill(groupCode);
  await page.getByLabel("Hourly Rate ($) *").fill("10.00");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByText("Group created.")).toBeVisible();

  await page.getByRole("tab", { name: "Stations" }).click();
  await page.getByRole("button", { name: "Add Station" }).click();
  await page.getByLabel("Number *").fill(stationNumber);
  await page.getByLabel("Name *").fill(stationName);
  await page.getByRole("combobox", { name: "None" }).click();
  await page.getByRole("option", { name: groupName }).click();
  await page.getByRole("button", { name: "Create station" }).click();
  await expect(page.getByText(stationName)).toBeVisible();

  const res = await page.request.get(`${API_URL}/rpc/stations`, {
    params: { pageSize: "1000" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; name: string }[] };
  const station = body.items.find((s) => s.name === stationName);
  expect(station).toBeDefined();
  return station!.id;
}

async function findMemberId(
  page: import("@playwright/test").Page,
  email: string,
): Promise<string> {
  const res = await page.request.get(`${API_URL}/rpc/members`, {
    params: { pageSize: "100" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; email: string }[] };
  const member = body.items.find((m) => m.email === email);
  expect(member).toBeDefined();
  return member!.id;
}

async function topUpWallet(
  page: import("@playwright/test").Page,
  memberId: string,
  amount: string,
): Promise<void> {
  const res = await page.request.post(`${API_URL}/rpc/wallets/${memberId}/credit`, {
    data: { amount },
  });
  expect(res.ok()).toBeTruthy();
}

test.describe("Sessions", () => {
  test("happy path: start, station-occupied 409, pause/resume, end, portal check", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2esess${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Sessions Owner", email: ownerEmail, slug });

    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: customerName, email: customerEmail });

    const stationId = await createBranchStationAndGroup(page, base, {
      branchName: `Branch ${uniq}`,
      groupName: `Group ${uniq}`,
      groupCode: `G${uniq}`.slice(0, 12),
      stationNumber: `S${uniq}`.slice(0, 12),
      stationName: `Station ${uniq}`,
    });
    const memberId = await findMemberId(page, customerEmail);
    await topUpWallet(page, memberId, "50.00");

    await page.goto(`${base}/dashboard/sessions`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Start Session" }).click();
    await page.getByRole("combobox").filter({ hasText: "Select a station" }).click();
    await page.getByRole("option", { name: new RegExp(`Station ${uniq}`) }).click();
    await page.getByLabel("Member ID").fill(memberId);
    await page.getByLabel(/Duration/).fill("60");
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page.getByText("Session started.")).toBeVisible();

    // Station is now occupied — a second start on the same station 409s.
    const secondStartRes = await page.request.post(`${API_URL}/rpc/sessions`, {
      data: { stationId, memberId, durationMinutes: 30 },
    });
    expect(secondStartRes.status()).toBe(409);

    // Confirm the running session's row and grab its id.
    const listRes = await page.request.get(`${API_URL}/rpc/sessions`, {
      params: { pageSize: "20" },
    });
    expect(listRes.ok()).toBeTruthy();
    const listBody = (await listRes.json()) as {
      items: { id: string; status: string; pausedAt: string | null }[];
    };
    const active = listBody.items.find((s) => s.status === "active");
    expect(active).toBeDefined();
    const sessionId = active!.id;

    // Pause via UI, assert pausedAt is set (not a visual wait for a ticking timer).
    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Session paused.")).toBeVisible();

    const pausedRes = await page.request.get(`${API_URL}/rpc/sessions`, {
      params: { pageSize: "20" },
    });
    const pausedBody = (await pausedRes.json()) as {
      items: { id: string; status: string; pausedAt: string | null }[];
    };
    const paused = pausedBody.items.find((s) => s.id === sessionId);
    expect(paused?.status).toBe("paused");
    expect(paused?.pausedAt).not.toBeNull();

    // Resume via UI.
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByText("Session resumed.")).toBeVisible();

    // End early — wallet balance should drop and the station return to available.
    await page.getByRole("button", { name: "End" }).click();
    await expect(page.getByText("Session ended.")).toBeVisible();

    const walletRes = await page.request.get(`${API_URL}/rpc/wallets/${memberId}`);
    expect(walletRes.ok()).toBeTruthy();
    const walletBody = (await walletRes.json()) as { balance: string };
    expect(Number(walletBody.balance)).toBeLessThan(50);

    const stationsRes = await page.request.get(`${API_URL}/rpc/stations`, {
      params: { pageSize: "1000" },
    });
    const stationsBody = (await stationsRes.json()) as {
      items: { id: string; status: string }[];
    };
    const stationAfter = stationsBody.items.find((s) => s.id === stationId);
    expect(stationAfter?.status).toBe("available");

    // Customer's portal no longer shows a current session.
    await pageCust.reload();
    await expect(pageCust.getByText(/current session/i)).toHaveCount(0);
    await ctxCust.close();
  });

  test("role gate: a customer's portal session is refused on staff session routes; staff has full access", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2esessgate${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const staffSlug = `e2esessgateinv${uniq}`;
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Sessions Owner", email: ownerEmail, slug });

    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: customerName, email: customerEmail });

    // A customer (member-only credential) hitting the staff sessions route is refused.
    const crossRes = await pageCust.request.post(`${API_URL}/rpc/sessions`, {
      data: { stationId: "does-not-matter", memberId: "does-not-matter" },
    });
    expect([401, 403]).toContain(crossRes.status());

    const stationId = await createBranchStationAndGroup(page, base, {
      branchName: `Branch ${uniq}`,
      groupName: `Group ${uniq}`,
      groupCode: `G${uniq}`.slice(0, 12),
      stationNumber: `S${uniq}`.slice(0, 12),
      stationName: `Station ${uniq}`,
    });
    const memberId = await findMemberId(page, customerEmail);
    await topUpWallet(page, memberId, "20.00");
    await ctxCust.close();

    // Invite a staff member and confirm they can drive the full session lifecycle.
    await page.goto(`${base}/dashboard/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await signUp(page, { name: "Sessions Staff", email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
      timeout: 15_000,
    });

    await page.goto(`${base}/dashboard/sessions`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Start Session" }).click();
    await page.getByRole("combobox").filter({ hasText: "Select a station" }).click();
    await page.getByRole("option", { name: new RegExp(`Station ${uniq}`) }).click();
    await page.getByLabel("Member ID").fill(memberId);
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page.getByText("Session started.")).toBeVisible();

    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Pause" }).click();
    await expect(page.getByText("Session paused.")).toBeVisible();
    await page.getByRole("button", { name: "Resume" }).click();
    await expect(page.getByText("Session resumed.")).toBeVisible();
    await page.getByRole("button", { name: "Extend" }).click();
    await page.getByLabel(/minutes to extend/i).fill("15");
    await page.getByRole("button", { name: "Extend session" }).click();
    await expect(page.getByText("Session extended.")).toBeVisible();
    await page.getByRole("button", { name: "End" }).click();
    await expect(page.getByText("Session ended.")).toBeVisible();

    void stationId;
  });

  test("tenant isolation: tenant A's session not visible to tenant B, and direct cross-tenant lifecycle calls 404", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2esessa${uniq}`;
    const slugB = `e2esessb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });

    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, baseA, { name: customerName, email: customerEmail });
    await ctxCust.close();

    await createBranchStationAndGroup(page, baseA, {
      branchName: `Branch ${uniq}`,
      groupName: `Group ${uniq}`,
      groupCode: `G${uniq}`.slice(0, 12),
      stationNumber: `S${uniq}`.slice(0, 12),
      stationName: `Station ${uniq}`,
    });
    const memberId = await findMemberId(page, customerEmail);
    await topUpWallet(page, memberId, "50.00");

    await page.goto(`${baseA}/dashboard/sessions`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Start Session" }).click();
    await page.getByRole("combobox").filter({ hasText: "Select a station" }).click();
    await page.getByRole("option", { name: new RegExp(`Station ${uniq}`) }).click();
    await page.getByLabel("Member ID").fill(memberId);
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page.getByText("Session started.")).toBeVisible();

    const listRes = await page.request.get(`${API_URL}/rpc/sessions`, {
      params: { pageSize: "20" },
    });
    const listBody = (await listRes.json()) as { items: { id: string; status: string }[] };
    const sessionId = listBody.items.find((s) => s.status === "active")!.id;

    // Tenant B
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });

    await pageB.goto(`${baseB}/dashboard/sessions`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(customerName)).toHaveCount(0);
    await expect(pageB.getByText(`Station ${uniq}`)).toHaveCount(0);

    const crossPause = await pageB.request.post(
      `${API_URL}/rpc/sessions/${sessionId}/pause`,
    );
    expect(crossPause.status()).toBe(404);

    const crossEnd = await pageB.request.post(`${API_URL}/rpc/sessions/${sessionId}/end`);
    expect(crossEnd.status()).toBe(404);

    const crossExtend = await pageB.request.post(
      `${API_URL}/rpc/sessions/${sessionId}/extend`,
      { data: { minutes: 10 } },
    );
    expect(crossExtend.status()).toBe(404);

    await ctxB.close();
  });

  test("credit grants: a member with $0 wallet balance and a credit grant can start a session, and closing it consumes credit minutes before touching the wallet", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2esesscred${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Sessions Owner", email: ownerEmail, slug });

    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: customerName, email: customerEmail });
    await ctxCust.close();

    await createBranchStationAndGroup(page, base, {
      branchName: `Branch ${uniq}`,
      groupName: `Group ${uniq}`,
      groupCode: `G${uniq}`.slice(0, 12),
      stationNumber: `S${uniq}`.slice(0, 12),
      stationName: `Station ${uniq}`,
    });
    const memberId = await findMemberId(page, customerEmail);

    // No wallet top-up — the member starts at $0.00. Grant 60 minutes of
    // credit instead of cash.
    const grantRes = await page.request.post(
      `${API_URL}/rpc/credits/members/${memberId}/grant`,
      { data: { quantityMinutes: 60, reason: "e2e: credit-funded session" } },
    );
    expect(grantRes.ok()).toBeTruthy();

    // Starting a session with $0 wallet balance used to 422 unconditionally —
    // it now succeeds because the member holds an eligible credit grant.
    await page.goto(`${base}/dashboard/sessions`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Start Session" }).click();
    await page.getByRole("combobox").filter({ hasText: "Select a station" }).click();
    await page.getByRole("option", { name: new RegExp(`Station ${uniq}`) }).click();
    await page.getByLabel("Member ID").fill(memberId);
    await page.getByRole("button", { name: "Start session" }).click();
    await expect(page.getByText("Session started.")).toBeVisible();

    const listRes = await page.request.get(`${API_URL}/rpc/sessions`, {
      params: { pageSize: "20" },
    });
    const listBody = (await listRes.json()) as { items: { id: string; status: string }[] };
    const sessionId = listBody.items.find((s) => s.status === "active")!.id;

    await page.reload();
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "End" }).click();
    await expect(page.getByText("Session ended.")).toBeVisible();

    // The brief automated-test session is fully covered by the credit grant —
    // the wallet is never touched.
    const walletRes = await page.request.get(`${API_URL}/rpc/wallets/${memberId}`);
    expect(walletRes.ok()).toBeTruthy();
    const walletBody = (await walletRes.json()) as { wallet: { balance: string } };
    expect(walletBody.wallet.balance).toBe("0.00");

    const endedRes = await page.request.get(`${API_URL}/rpc/sessions`, {
      params: { pageSize: "20" },
    });
    const endedBody = (await endedRes.json()) as {
      items: { id: string; status: string; creditMinutesConsumed: number; amountCharged: string | null }[];
    };
    const ended = endedBody.items.find((s) => s.id === sessionId);
    expect(ended?.status).toBe("ended");
    expect(ended?.creditMinutesConsumed ?? 0).toBeGreaterThanOrEqual(1);
    expect(ended?.amountCharged === null || Number(ended?.amountCharged) === 0).toBe(true);

    const grantsRes = await page.request.get(
      `${API_URL}/rpc/credits/members/${memberId}/grants`,
      { params: { pageSize: "10" } },
    );
    expect(grantsRes.ok()).toBeTruthy();
    const grantsBody = (await grantsRes.json()) as { items: { remainingQuantity: number }[] };
    expect(grantsBody.items[0]?.remainingQuantity).toBeLessThan(60);
  });
});
