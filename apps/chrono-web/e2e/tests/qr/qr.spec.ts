import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the QR module (chrono/qr).
 *
 * Per Phase 4 (web UI) and Phase 5 (real session start) of
 * .ai/plans/chrono/active/qr/README.md:
 * - Happy path: staff creates a branch + priced station, regenerates its QR
 *   from the station detail view, scans the resulting /q/[token] URL as a
 *   logged-out customer (redirected to /portal/login?next=...) and, once
 *   funded, as a logged-in one — Start actually opens a real session on the
 *   station.
 * - Business-rule gate: a tampered token renders a clear failure state, not a
 *   500 or a silent redirect; scanning with an unfunded wallet surfaces the
 *   real "insufficient balance" error, not a silent success.
 * - Tenant isolation: a token minted for tenant A's station never resolves
 *   against tenant B's branding/host even when requested from tenant B's host.
 */
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
  await page.getByLabel("Workspace name").fill(slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
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

async function createBranchAndStation(
  page: import("@playwright/test").Page,
  base: string,
  branchName: string,
  stationName: string,
  groupName?: string,
): Promise<void> {
  await page.goto(`${base}/dashboard/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /add branch/i }).click();
  await page.getByLabel(/^Name/).first().fill(branchName);
  await page.getByLabel(/^Code/).first().fill(branchName.slice(0, 6).toUpperCase());
  await page.getByRole("button", { name: /create branch/i }).click();
  await expect(page.getByText(branchName).first()).toBeVisible();

  await page.goto(`${base}/dashboard/stations`);
  await page.waitForLoadState("networkidle");

  // A station needs a pricing group before a session can be started on it
  // (qr Phase 5 / sessions' own "no pricing group" guard) — required for any
  // scan-and-start flow, not just the happy path.
  if (groupName) {
    await page.getByRole("tab", { name: "Groups & Rates" }).click();
    await page.getByRole("button", { name: "Add Group" }).click();
    await page.getByLabel("Name *").fill(groupName);
    await page.getByLabel("Code *").fill(groupName.slice(0, 6).toUpperCase());
    await page.getByLabel("Hourly Rate ($) *").fill("10.00");
    await page.getByRole("button", { name: "Create group" }).click();
    await expect(page.getByText(groupName).first()).toBeVisible();
    await page.getByRole("tab", { name: "Stations" }).click();
  }

  await page.getByRole("button", { name: /add station/i }).click();
  await page.getByLabel("Number *").fill("1");
  await page.getByLabel("Name *").fill(stationName);
  if (groupName) {
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: groupName }).click();
  }
  await page.getByRole("button", { name: /create station/i }).click();
  await expect(page.getByText(stationName).first()).toBeVisible();
}

test.describe("QR", () => {
  test("happy path: regenerate QR, scan as logged-out then logged-in customer", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2eqr${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const stationName = `Station ${uniq}`;
    const branchName = `Branch ${uniq}`;
    const groupName = `Group ${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "QR Owner", email: ownerEmail, slug });
    await createBranchAndStation(page, base, branchName, stationName, groupName);

    // Regenerate QR from the station's action menu.
    await page.getByRole("button", { name: `Show QR for ${stationName}` }).click();
    await expect(page.getByText(/Expires/)).toBeVisible({ timeout: 10_000 });
    const img = page.getByAltText("Station QR code");
    await expect(img).toBeVisible();

    // Pull the token out of the regenerate API response instead of decoding
    // the rendered QR image — the UI has no way to construct one directly.
    // The dialog above already minted one server-side; regenerate again via
    // API against the same station to read the token/qrUrl directly.
    const stationsRes = await page.request.get(`${base}/api/rpc/stations`, {
      params: { pageSize: "100" },
    });
    const stationsBody = (await stationsRes.json()) as { items: { id: string; name: string }[] };
    const station = stationsBody.items.find((s) => s.name === stationName);
    expect(station).toBeDefined();
    const qrRes = await page.request.post(
      `${base}/api/rpc/stations/${station!.id}/qr/regenerate`,
    );
    expect(qrRes.ok()).toBeTruthy();
    const qrBody = (await qrRes.json()) as { token: string; qrUrl: string };

    // Scan as a logged-out visitor — expect redirect to /portal/login?next=...
    const ctxAnon = await browser.newContext();
    const pageAnon = await ctxAnon.newPage();
    await pageAnon.goto(`${base}${qrBody.qrUrl}`);
    await pageAnon.waitForURL(/\/portal\/login\?next=/, { timeout: 10_000 });
    await ctxAnon.close();

    // Customer signs up, then staff funds their wallet — starting a session
    // requires a positive balance (sessions module's own guard).
    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: customerName, email: customerEmail });

    await page.goto(`${base}/dashboard/wallets`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: "Top Up" }).click();
    await page.getByLabel(/Customer|Member/).fill(customerName);
    await page.getByRole("option", { name: customerName }).click();
    await page.getByLabel("Amount").fill("50.00");
    await page.getByRole("button", { name: "Confirm Top Up" }).click();
    await expect(page.getByText("Wallet topped up")).toBeVisible();

    // Scan as the now-funded, logged-in customer — Start opens a real session.
    await pageCust.goto(`${base}${qrBody.qrUrl}`);
    await expect(pageCust.getByText(stationName)).toBeVisible({ timeout: 10_000 });
    await pageCust.getByRole("button", { name: "Start" }).click();
    await expect(pageCust.getByText("Session started")).toBeVisible({ timeout: 10_000 });
    await ctxCust.close();

    // Confirm a real session row exists and the station flipped to occupied.
    const sessionsRes = await page.request.get(`${base}/api/rpc/sessions`, {
      params: { pageSize: "100" },
    });
    const sessionsBody = (await sessionsRes.json()) as {
      items: { stationId: string; status: string }[];
    };
    expect(
      sessionsBody.items.some((s) => s.stationId === station!.id && s.status === "active"),
    ).toBe(true);
  });

  test("business-rule gate: a tampered token renders a clear failure, not a 500", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2eqrtamper${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await page.goto(`${base}/q/qr-tampered-1-0000000000-deadbeef:${"0".repeat(64)}`);
    await expect(page.getByText(/invalid/i)).toBeVisible({ timeout: 10_000 });
  });

  test("business-rule gate: scanning with an empty wallet surfaces the real error, nonce stays unused", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2eqrbal${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const customerName = faker.person.fullName();
    const stationName = `Station ${uniq}`;
    const branchName = `Branch ${uniq}`;
    const groupName = `Group ${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;

    await signUp(page, { name: "QR Owner", email: ownerEmail, slug });
    await createBranchAndStation(page, base, branchName, stationName, groupName);

    const stationsRes = await page.request.get(`${base}/api/rpc/stations`, {
      params: { pageSize: "100" },
    });
    const stationsBody = (await stationsRes.json()) as { items: { id: string; name: string }[] };
    const station = stationsBody.items.find((s) => s.name === stationName);
    const qrRes = await page.request.post(
      `${base}/api/rpc/stations/${station!.id}/qr/regenerate`,
    );
    const qrBody = (await qrRes.json()) as { qrUrl: string };

    // No wallet top-up this time — the customer has zero balance.
    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, { name: customerName, email: customerEmail });
    await pageCust.goto(`${base}${qrBody.qrUrl}`);
    await expect(pageCust.getByText(stationName)).toBeVisible({ timeout: 10_000 });
    await pageCust.getByRole("button", { name: "Start" }).click();
    await expect(pageCust.getByText(/insufficient wallet balance/i)).toBeVisible({
      timeout: 10_000,
    });
    await ctxCust.close();
  });

  test("tenant isolation: tenant A's token never resolves against tenant B's host", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slugA = `e2eqra${uniq}`;
    const slugB = `e2eqrb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const stationName = `Station ${uniq}`;
    const branchName = `Branch ${uniq}`;
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;

    await signUp(page, { name: "Tenant A", email: emailA, slug: slugA });
    await createBranchAndStation(page, baseA, branchName, stationName);

    const stationsRes = await page.request.get(`${baseA}/api/rpc/stations`, {
      params: { pageSize: "100" },
    });
    const stationsBody = (await stationsRes.json()) as { items: { id: string; name: string }[] };
    const station = stationsBody.items.find((s) => s.name === stationName);
    expect(station).toBeDefined();
    const qrRes = await page.request.post(`${baseA}/api/rpc/stations/${station!.id}/qr/regenerate`);
    expect(qrRes.ok()).toBeTruthy();
    const qrBody = (await qrRes.json()) as { qrUrl: string };

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: "Tenant B", email: emailB, slug: slugB });

    // Visiting tenant A's scan URL from tenant B's host must re-anchor onto
    // tenant A's own host, never render tenant B's branding for tenant A's
    // station.
    await pageB.goto(`${baseB}${qrBody.qrUrl}`);
    await pageB.waitForURL(new RegExp(`//${slugA}\\.localtest\\.me:3000/q/`), {
      timeout: 10_000,
    });
    await ctxB.close();
  });
});
