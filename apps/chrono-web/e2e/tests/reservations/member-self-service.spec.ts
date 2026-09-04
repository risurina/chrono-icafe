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
  await page.waitForURL(`${base}/portal`, { timeout: 15_000 });
}

/** Create a branch + station for a tenant via the staff dashboard API, so the
 * member portal's public station grid has something to book. Staff-authed
 * `page` must already be signed in on that tenant's host. */
async function seedStation(page: import("@playwright/test").Page, stationName: string) {
  const branchRes = await page.request.post(`${apiUrl}/rpc/branches`, {
    data: { name: `Branch ${stationName}`, code: stationName.slice(0, 8).toUpperCase() },
  });
  expect(branchRes.ok()).toBeTruthy();
  const branch = (await branchRes.json()) as { branch: { id: string } };
  const stationRes = await page.request.post(`${apiUrl}/rpc/stations`, {
    data: {
      branchId: branch.branch.id,
      name: stationName,
      stationNumber: "1",
    },
  });
  expect(stationRes.ok()).toBeTruthy();
  const station = (await stationRes.json()) as { station: { id: string } };
  // Activate the branch so it's visible on /public/stations (only "active"
  // branches show — see station/routes.ts's publicStationRoutes).
  await page.request.patch(`${apiUrl}/rpc/branches/${branch.branch.id}`, {
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
    const { stationId } = await seedStation(page, `Station-${uniq}`);

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
    await pageMember.goto(`${base}/portal/reservations`);
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
    const { stationId } = await seedStation(page, `Station-${uniq}`);

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
    const { stationId } = await seedStation(page, `Station-${uniqA}`);

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
