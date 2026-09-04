import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the Reservations module (chrono/reservations).
 * Mirrors `branches`' own e2e structure and `signUp()` helper
 * (apps/chrono-web/e2e/tests/branches/branches.spec.ts).
 *
 * There is no Stations dashboard page yet, so branch + station setup uses the
 * real dashboard UI for the branch and a direct `page.request` call against
 * `/rpc/stations` (already tenant-scoped + permission-gated the same as any
 * UI-driven call) for the station — same approach
 * `public-api/v1-projects.spec.ts` uses for API-key minting.
 *
 * Per `.ai/rules/e2e-testing.md` + Phase 5 of
 * `.ai/plans/chrono/active/reservations/README.md`: happy path, the
 * tenant-membership gate (this module grants staff/admin/owner identical
 * `reservation:manage` permissions in this pass, so there is no role split to
 * test — see the plan's Open Question 7), and cross-tenant isolation.
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
  });
}

/** Create a branch through the real dashboard UI (mirrors branches.spec.ts). */
async function createBranch(
  page: import("@playwright/test").Page,
  base: string,
  name: string,
): Promise<void> {
  await page.goto(`${base}/admin/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(name)).toBeVisible();
}

/** Look up a branch's id from the tenant-scoped list (no stations UI to read it from). */
async function findBranchId(
  page: import("@playwright/test").Page,
  name: string,
): Promise<string> {
  const res = await page.request.get(`${API_URL}/rpc/branches`, {
    params: { pageSize: "100" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; name: string }[] };
  const branch = body.items.find((b) => b.name === name);
  expect(branch).toBeTruthy();
  return branch!.id;
}

/** Create a station via `/rpc/stations` — no dashboard page exists for this yet. */
async function createStation(
  page: import("@playwright/test").Page,
  branchId: string,
  name: string,
): Promise<string> {
  const res = await page.request.post(`${API_URL}/rpc/stations`, {
    data: {
      branchId,
      name,
      stationNumber: faker.string.numeric(3),
    },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { station: { id: string } };
  return body.station.id;
}

test.describe("Reservations", () => {
  test("create a walk-in reservation, check it in, then create and cancel a second one", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2eres${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;
    const stationName = `${faker.commerce.productName()} Station`;
    const customerName = faker.person.fullName();
    const customerPhone = faker.phone.number();

    await signUp(page, { name: "PW Owner", email, slug });

    await createBranch(page, base, branchName);
    const branchId = await findBranchId(page, branchName);
    await createStation(page, branchId, stationName);

    await page.goto(`${base}/admin/reservations`);
    await page.waitForLoadState("networkidle");

    // The board defaults to today; give it a moment to load branches/stations.
    await expect(page.getByRole("combobox").first()).toBeVisible();

    // Create a walk-in reservation (no member).
    await page.getByRole("button", { name: "Add Reservation" }).click();
    await page.getByLabel("Station").click();
    await page.getByRole("option", { name: stationName }).click();
    await page.getByText("Walk-in (no member account)").click();
    await page.getByLabel("Customer name").fill(customerName);
    await page.getByLabel("Phone").fill(customerPhone);

    const now = new Date();
    const start = new Date(now.getTime() + 60 * 60 * 1000);
    const end = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const toLocal = (d: Date) => {
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
        d.getHours(),
      )}:${pad(d.getMinutes())}`;
    };
    await page.getByLabel("Start").fill(toLocal(start));
    await page.getByLabel("End").fill(toLocal(end));
    await page.getByRole("button", { name: "Create reservation" }).click();
    await expect(page.getByText("Reservation created.")).toBeVisible();
    await expect(page.getByText(customerName)).toBeVisible();

    // Check it in — status updates in the UI.
    await page.getByRole("button", { name: "Check In" }).click();
    await expect(page.getByText("Checked in.")).toBeVisible();
    await expect(page.getByText("Checked in", { exact: true })).toBeVisible();

    // Second reservation, later the same day, then cancel it.
    const secondCustomer = faker.person.fullName();
    const start2 = new Date(now.getTime() + 3 * 60 * 60 * 1000);
    const end2 = new Date(now.getTime() + 4 * 60 * 60 * 1000);

    await page.getByRole("button", { name: "Add Reservation" }).click();
    await page.getByLabel("Station").click();
    await page.getByRole("option", { name: stationName }).click();
    await page.getByText("Walk-in (no member account)").click();
    await page.getByLabel("Customer name").fill(secondCustomer);
    await page.getByLabel("Start").fill(toLocal(start2));
    await page.getByLabel("End").fill(toLocal(end2));
    await page.getByRole("button", { name: "Create reservation" }).click();
    await expect(page.getByText("Reservation created.")).toBeVisible();
    await expect(page.getByText(secondCustomer)).toBeVisible();

    const secondRow = page.getByRole("row", { name: new RegExp(secondCustomer) });
    await secondRow.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Reservation cancelled.")).toBeVisible();
    await expect(secondRow.getByText("Cancelled")).toBeVisible();
  });

  test("an unauthenticated request to /rpc/reservations is refused", async ({
    request,
  }) => {
    // No sign-up/sign-in in this test at all — a bare, cookie-less request.
    const res = await request.get(`${API_URL}/rpc/reservations`, {
      params: { branchId: "does-not-matter" },
    });
    expect(res.ok()).toBeFalsy();
    expect([401, 403]).toContain(res.status());
  });

  test("a reservation from one tenant never appears on another tenant's board, and a direct GET by id 404s cross-tenant", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2eresa${uniq}`;
    const slugB = `e2eresb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;
    const branchNameA = `${faker.company.name()} Branch`;
    const branchNameB = `${faker.company.name()} Branch`;
    const stationNameA = "Acme Only Station";
    const customerName = faker.person.fullName();

    // Tenant A: branch, station, and a reservation on it.
    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });
    await createBranch(page, baseA, branchNameA);
    const branchIdA = await findBranchId(page, branchNameA);
    const stationIdA = await createStation(page, branchIdA, stationNameA);

    const now = new Date();
    const startAt = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    const endAt = new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString();
    const createRes = await page.request.post(`${API_URL}/rpc/reservations`, {
      data: {
        branchId: branchIdA,
        stationId: stationIdA,
        customerName,
        startAt,
        endAt,
      },
    });
    expect(createRes.ok()).toBeTruthy();
    const { reservation } = (await createRes.json()) as { reservation: { id: string } };

    // Tenant B: its own branch and station, its own board.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });
    await createBranch(pageB, baseB, branchNameB);
    const branchIdB = await findBranchId(pageB, branchNameB);
    await createStation(pageB, branchIdB, "B's Own Station");

    await pageB.goto(`${baseB}/admin/reservations`);
    await pageB.waitForLoadState("networkidle");
    await expect(pageB.getByText(customerName)).toHaveCount(0);
    await expect(pageB.getByText(stationNameA)).toHaveCount(0);

    // Direct GET by id, from tenant B's own session, against tenant A's id → 404.
    const crossRes = await pageB.request.get(`${API_URL}/rpc/reservations/${reservation.id}`);
    expect(crossRes.status()).toBe(404);

    await ctxB.close();
  });
});
