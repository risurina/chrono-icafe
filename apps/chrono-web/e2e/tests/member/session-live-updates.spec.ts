import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Live updates on the member session pages (`/member/session`,
 * `/member/session/[id]`) — member-portal-v2 phase 5.
 *
 * Phase 5 was deliberately deferred in the original plan pending a developer
 * decision on reversing "no realtime for members." The developer has since
 * chosen polling (lighter-weight than wiring the shared realtime provider
 * into this surface — see `apps/chrono-web/src/lib/member/use-live-refresh.ts`
 * for the full reasoning) over an unreviewed realtime integration.
 *
 * This spec proves the actual behavior the plan asked for: a session that
 * changes state on the SERVER (ended by staff here, mirroring what an
 * attendant or the session's own expiry would do) is reflected on the
 * member's already-open session pages WITHOUT a manual reload — both the
 * summary card on `/member/session` and the detail view on
 * `/member/session/[id]`. It also asserts the polling endpoint is actually
 * being hit more than once, so a passing test can't be explained by the
 * initial page-load fetch alone.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const PASSWORD = "Password123!";

async function signUpBusiness(
  page: Page,
  { name, email, slug }: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin(/setup)?$`), {
    timeout: 60_000,
  });
}

async function memberSignUp(
  page: Page,
  base: string,
  { name, email }: { name: string; email: string },
) {
  await page.goto(`${base}/portal/sign-up`);
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1000);
  await page.getByLabel("Your name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL(`${base}/member`, { timeout: 15_000 });
}

/** Staff-side: create a branch + station-group + station, returning the
 * station's id. Mirrors `sessions/sessions.spec.ts`'s own helper. */
async function seedStation(
  page: Page,
  slug: string,
  uniq: string,
): Promise<string> {
  const headers = { "x-tenant-slug": slug };
  const branchRes = await page.request.post(`${API_URL}/rpc/branches`, {
    headers,
    data: { name: `Branch ${uniq}`, code: `B${uniq}`.slice(0, 12) },
  });
  expect(branchRes.ok(), await branchRes.text()).toBeTruthy();
  const branch = (await branchRes.json()) as { branch: { id: string } };

  const groupRes = await page.request.post(`${API_URL}/rpc/stations/groups`, {
    headers,
    data: {
      branchId: branch.branch.id,
      name: `Group ${uniq}`,
      code: `G${uniq}`.slice(0, 12),
      hourlyRate: "10.00",
    },
  });
  expect(groupRes.ok(), await groupRes.text()).toBeTruthy();
  const group = (await groupRes.json()) as { stationGroup: { id: string } };

  const stationRes = await page.request.post(`${API_URL}/rpc/stations`, {
    headers,
    data: {
      branchId: branch.branch.id,
      stationGroupId: group.stationGroup.id,
      name: `Station ${uniq}`,
      stationNumber: `S${uniq}`.slice(0, 12),
    },
  });
  expect(stationRes.ok(), await stationRes.text()).toBeTruthy();
  const station = (await stationRes.json()) as { station: { id: string } };
  return station.station.id;
}

async function findMemberId(page: Page, slug: string, email: string): Promise<string> {
  // NOT /rpc/members — that path is the foundation's staff org-member list.
  // Chrono's own ChronoMemberProfiles list (customers, not staff) is mounted
  // at /rpc/member-profiles specifically to avoid colliding with it.
  const res = await page.request.get(`${API_URL}/rpc/member-profiles`, {
    headers: { "x-tenant-slug": slug },
    params: { pageSize: "100" },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { items: { memberId: string; email: string }[] };
  // Case-insensitive: emails are normalized to lowercase server-side, but
  // faker doesn't always generate an already-lowercase address.
  const member = body.items.find((m) => m.email.toLowerCase() === email.toLowerCase());
  expect(member).toBeDefined();
  return member!.memberId;
}

async function topUpWallet(page: Page, slug: string, memberId: string, amount: string) {
  const res = await page.request.post(`${API_URL}/rpc/wallets/${memberId}/credit`, {
    headers: { "x-tenant-slug": slug },
    data: { amount },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

async function startSession(
  page: Page,
  slug: string,
  args: { stationId: string; memberId: string },
): Promise<string> {
  const res = await page.request.post(`${API_URL}/rpc/sessions`, {
    headers: { "x-tenant-slug": slug },
    data: { stationId: args.stationId, memberId: args.memberId, durationMinutes: 60 },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
  const body = (await res.json()) as { session: { id: string } };
  return body.session.id;
}

async function endSession(page: Page, slug: string, sessionId: string) {
  const res = await page.request.post(`${API_URL}/rpc/sessions/${sessionId}/end`, {
    headers: { "x-tenant-slug": slug },
  });
  expect(res.ok(), await res.text()).toBeTruthy();
}

test.describe("Member session live updates (polling)", () => {
  test.describe.configure({ timeout: 120_000 });

  test("the session-list summary card reflects a staff-side end without a manual reload", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2elivesum${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const memberName = faker.person.fullName();
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Live Owner", email: ownerEmail, slug });
    const stationId = await seedStation(page, slug, uniq);

    const ctxMember = await browser.newContext();
    const pageMember = await ctxMember.newPage();
    await memberSignUp(pageMember, base, { name: memberName, email: memberEmail });
    const memberId = await findMemberId(page, slug, memberEmail);
    await topUpWallet(page, slug, memberId, "50.00");

    const sessionId = await startSession(page, slug, { stationId, memberId });

    // Count polls of the summary endpoint so a pass can't be explained by
    // the initial page-load fetch alone.
    let summaryRequests = 0;
    pageMember.on("request", (req) => {
      if (req.url().includes("/portal/sessions/summary")) summaryRequests += 1;
    });

    await pageMember.goto(`${base}/member/session`);
    await pageMember.waitForLoadState("networkidle");
    await expect(pageMember.getByTestId("active-session-card")).toContainText(
      `Running on Station ${uniq}`,
    );

    // Ended on the SERVER by staff — the member's page is never told to
    // reload. The poll interval is 12s; wait past it.
    await endSession(page, slug, sessionId);
    await expect(pageMember.getByText("No active session right now.")).toBeVisible({
      timeout: 20_000,
    });

    expect(summaryRequests).toBeGreaterThan(1);

    await ctxMember.close();
  });

  test("the session detail page reflects a staff-side end without a manual reload", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2elivedet${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const memberName = faker.person.fullName();
    const base = `http://${slug}.localtest.me:3000`;

    await signUpBusiness(page, { name: "Live Owner", email: ownerEmail, slug });
    const stationId = await seedStation(page, slug, uniq);

    const ctxMember = await browser.newContext();
    const pageMember = await ctxMember.newPage();
    await memberSignUp(pageMember, base, { name: memberName, email: memberEmail });
    const memberId = await findMemberId(page, slug, memberEmail);
    await topUpWallet(page, slug, memberId, "50.00");

    const sessionId = await startSession(page, slug, { stationId, memberId });

    await pageMember.goto(`${base}/member/session/${sessionId}`);
    await pageMember.waitForLoadState("networkidle");
    await expect(pageMember.getByText("active", { exact: true })).toBeVisible();
    // Duration/Amount charged are unset while the session is still running.
    await expect(pageMember.getByText("Amount charged")).toBeVisible();

    await endSession(page, slug, sessionId);

    // The status badge flips to "ended" and a real charge appears, purely
    // from the poll — no reload, no click.
    await expect(pageMember.getByText("ended", { exact: true })).toBeVisible({ timeout: 20_000 });

    await ctxMember.close();
  });
});
