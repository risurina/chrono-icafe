import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the member self-service reservation/queue flow
 * (`.ai/plans/chrono/active/reservations-queue-and-self-service/README.md`,
 * Phase 7). Distinct from the existing staff-facing
 * `reservations/reservations.spec.ts` — this covers `/portal/reservations`
 * (member-auth-gated), not the staff `/admin/reservations` board.
 *
 * - Happy path: a member reserves an available station within the advance
 *   window and sees it reflected on their own portal page.
 * - Policy enforcement: a reservation outside the advance window is rejected.
 * - Tenant isolation: tenant B's member cannot see or act on tenant A's
 *   reservation, even guessing its id directly against the API.
 */
const SEEDED_PASSWORD = "Password123!";
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

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

/**
 * Create a branch + station for a tenant via the staff dashboard API, so the
 * member portal's public station grid has something to book. Staff-authed
 * `page` must already be signed in on that tenant's host.
 *
 * These calls go straight to the API origin (`localhost:8787`/
 * `api.localtest.me:8787`), not through the web app's same-origin proxy — so
 * `tenantMiddleware` has no host to resolve a tenant from unless the request
 * carries `x-tenant-slug` explicitly. Without it every such call 401s
 * regardless of the session cookie.
 */
async function seedStation(
  page: import("@playwright/test").Page,
  slug: string,
  stationName: string,
) {
  const headers = { "x-tenant-slug": slug };
  const branchRes = await page.request.post(`${apiUrl}/rpc/branches`, {
    headers,
    data: { name: `Branch ${stationName}`, code: stationName.slice(0, 8).toUpperCase() },
  });
  expect(branchRes.ok(), await branchRes.text()).toBeTruthy();
  const branch = (await branchRes.json()) as { branch: { id: string } };
  const stationRes = await page.request.post(`${apiUrl}/rpc/stations`, {
    headers,
    data: {
      branchId: branch.branch.id,
      name: stationName,
      stationNumber: "1",
    },
  });
  expect(stationRes.ok(), await stationRes.text()).toBeTruthy();
  const station = (await stationRes.json()) as { station: { id: string } };
  // Activate the branch so it's visible on /public/stations (only "active"
  // branches show — see station/routes.ts's publicStationRoutes).
  await page.request.patch(`${apiUrl}/rpc/branches/${branch.branch.id}`, {
    headers,
    data: { status: "active" },
  });
  return { branchId: branch.branch.id, stationId: station.station.id };
}

test.describe("Member reservations", () => {
  test("happy path: member reserves an available station within the advance window", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eresv${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const memberEmail = faker.internet.email({ provider: "example.com" });
    const memberName = faker.person.fullName();
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "Owner", email: ownerEmail, slug });
    const { stationId } = await seedStation(page, slug, `Station-${uniq}`);

    const ctxMember = await browser.newContext();
    const pageMember = await ctxMember.newPage();
    await portalSignUp(pageMember, base, { name: memberName, email: memberEmail });

    const startAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const reserveRes = await pageMember.request.post(`${apiUrl}/portal/reservations`, {
      headers: { "x-tenant-slug": slug, "Content-Type": "application/json" },
      data: { stationId, startAt, durationMinutes: 60 },
    });
    expect(reserveRes.ok(), await reserveRes.text()).toBeTruthy();
    const created = (await reserveRes.json()) as { reservation: { id: string; status: string } };
    expect(created.reservation.status).toBe("confirmed");

    // The member's own portal page reflects the active reservation.
    await pageMember.goto(`${base}/member/reservations`);
    await pageMember.waitForLoadState("networkidle");
    await expect(pageMember.getByText("Your reservation")).toBeVisible();

    await ctxMember.close();
  });

  test("advance-window rejection: a start time too far in the future is refused", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eresvwin${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, {
      name: "Owner",
      email: faker.internet.email({ provider: "example.com" }),
      slug,
    });
    const { stationId } = await seedStation(page, slug, `Station-${uniq}`);

    const ctxMember = await browser.newContext();
    const pageMember = await ctxMember.newPage();
    await portalSignUp(pageMember, base, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
    });

    // Default reservationAdvanceWindowMinutes is 60 — 2 hours out must be refused.
    const tooFar = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const res = await pageMember.request.post(`${apiUrl}/portal/reservations`, {
      headers: { "x-tenant-slug": slug, "Content-Type": "application/json" },
      data: { stationId, startAt: tooFar, durationMinutes: 60 },
    });
    expect(res.status()).toBe(400);

    await ctxMember.close();
  });

  test("tenant isolation: tenant B's member cannot see or act on tenant A's reservation", async ({
    page,
    browser,
  }) => {
    const uniqA = faker.string.alphanumeric(8).toLowerCase();
    const uniqB = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2eresva${uniqA}`;
    const slugB = `e2eresvb${uniqB}`;
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUp(page, {
      name: "Owner A",
      email: faker.internet.email({ provider: "example.com" }),
      slug: slugA,
    });
    const { stationId } = await seedStation(page, slugA, `Station-${uniqA}`);

    const ctxMemberA = await browser.newContext();
    const pageMemberA = await ctxMemberA.newPage();
    await portalSignUp(pageMemberA, baseA, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
    });
    const startAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const createRes = await pageMemberA.request.post(`${apiUrl}/portal/reservations`, {
      headers: { "x-tenant-slug": slugA, "Content-Type": "application/json" },
      data: { stationId, startAt, durationMinutes: 60 },
    });
    expect(createRes.ok()).toBeTruthy();
    const created = (await createRes.json()) as { reservation: { id: string } };
    const reservationIdA = created.reservation.id;

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, {
      name: "Owner B",
      email: faker.internet.email({ provider: "example.com" }),
      slug: slugB,
    });
    const ctxMemberB = await browser.newContext();
    const pageMemberB = await ctxMemberB.newPage();
    await portalSignUp(pageMemberB, baseB, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
    });

    // Tenant B's member has no active reservation of their own.
    const mineRes = await pageMemberB.request.get(`${apiUrl}/portal/reservations`, {
      headers: { "x-tenant-slug": slugB },
    });
    expect(mineRes.ok()).toBeTruthy();
    const mine = (await mineRes.json()) as { reservation: unknown };
    expect(mine.reservation).toBeNull();

    // Guessing tenant A's reservation id from tenant B's session must not
    // succeed — cancel is scoped by (tenantId, memberId), so this 404s.
    const crossCancelRes = await pageMemberB.request.post(
      `${apiUrl}/portal/reservations/${reservationIdA}/cancel`,
      { headers: { "x-tenant-slug": slugB, "Content-Type": "application/json" }, data: {} },
    );
    expect(crossCancelRes.status()).toBe(404);

    await ctxMemberA.close();
    await ctxB.close();
    await ctxMemberB.close();
  });
});

/**
 * Coverage for `GET /portal/reservations/availability` — the discrete
 * start-time slot picker (member-portal-v2 Phase 4). Uses the station's own
 * default timezone ("Asia/Manila", `chronoBranch.timezone`'s default — no
 * `hoursConfig` is set by `seedStation`, so slots are bounded only by the
 * reservation policy's advance window + existing reservations, matching the
 * "never fabricate a closed venue" fallback in `service.ts`'s
 * `computeAvailabilitySlots`).
 */
function manilaDateToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
}

test.describe("Reservation availability (slot picker)", () => {
  test("happy path: a member books a slot returned by the availability endpoint, and it becomes unavailable afterward", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eavail${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, {
      name: "Owner",
      email: faker.internet.email({ provider: "example.com" }),
      slug,
    });
    const { stationId } = await seedStation(page, slug, `Station-${uniq}`);

    const ctxMember = await browser.newContext();
    const pageMember = await ctxMember.newPage();
    await portalSignUp(pageMember, base, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
    });

    const date = manilaDateToday();
    const availRes = await pageMember.request.get(
      `${apiUrl}/portal/reservations/availability`,
      {
        headers: { "x-tenant-slug": slug },
        params: { stationId, date, durationMinutes: "60" },
      },
    );
    expect(availRes.ok(), await availRes.text()).toBeTruthy();
    const availability = (await availRes.json()) as {
      slots: { startAt: string; available: boolean }[];
    };
    const openSlot = availability.slots.find((s) => s.available);
    expect(openSlot, JSON.stringify(availability.slots)).toBeTruthy();

    const reserveRes = await pageMember.request.post(`${apiUrl}/portal/reservations`, {
      headers: { "x-tenant-slug": slug, "Content-Type": "application/json" },
      data: { stationId, startAt: openSlot!.startAt, durationMinutes: 60 },
    });
    expect(reserveRes.ok(), await reserveRes.text()).toBeTruthy();
    const created = (await reserveRes.json()) as { reservation: { status: string } };
    expect(created.reservation.status).toBe("confirmed");

    // The same slot must no longer be offered as available — it now overlaps
    // the reservation just created (the existing 409
    // RESERVATION_ALREADY_ACTIVE / overlap guard in `service.ts` is untouched
    // by this endpoint; this proves the READ side reflects it too).
    const availAfterRes = await pageMember.request.get(
      `${apiUrl}/portal/reservations/availability`,
      {
        headers: { "x-tenant-slug": slug },
        params: { stationId, date, durationMinutes: "60" },
      },
    );
    expect(availAfterRes.ok()).toBeTruthy();
    const availabilityAfter = (await availAfterRes.json()) as {
      slots: { startAt: string; available: boolean }[];
    };
    const sameSlot = availabilityAfter.slots.find((s) => s.startAt === openSlot!.startAt);
    expect(sameSlot?.available).toBe(false);

    await ctxMember.close();
  });

  test("tenant isolation: a member cannot read availability for another tenant's station", async ({
    page,
    browser,
  }) => {
    const uniqA = faker.string.alphanumeric(8).toLowerCase();
    const uniqB = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2eavaila${uniqA}`;
    const slugB = `e2eavailb${uniqB}`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUp(page, {
      name: "Owner A",
      email: faker.internet.email({ provider: "example.com" }),
      slug: slugA,
    });
    const { stationId: stationIdA } = await seedStation(page, slugA, `Station-${uniqA}`);

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, {
      name: "Owner B",
      email: faker.internet.email({ provider: "example.com" }),
      slug: slugB,
    });
    const ctxMemberB = await browser.newContext();
    const pageMemberB = await ctxMemberB.newPage();
    await portalSignUp(pageMemberB, baseB, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
    });

    const res = await pageMemberB.request.get(`${apiUrl}/portal/reservations/availability`, {
      headers: { "x-tenant-slug": slugB },
      params: { stationId: stationIdA, date: manilaDateToday(), durationMinutes: "60" },
    });
    expect(res.status()).toBe(404);

    await ctxB.close();
    await ctxMemberB.close();
  });
});
