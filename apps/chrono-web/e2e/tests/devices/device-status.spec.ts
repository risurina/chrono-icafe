import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Phase 6 e2e coverage for Phase 4 of
 * .ai/plans/chrono/in-progress/pc-client-tauri-api-integration/README.md —
 * `GET /api/v1/device/session/active` and `GET /api/v1/device/wallet/balance`
 * (device-bearer-gated, no staff session, no chrono-web UI in this pass).
 *
 * These are device-bearer REST reads, not staff/RPC routes, so — following
 * `devices/devices.spec.ts`'s established precedent for this route family —
 * they are called directly via the Playwright `request`/`page.request`
 * fixture (`Authorization: Bearer <deviceToken>` + `X-Device-Fingerprint`
 * headers, exactly like that spec's own heartbeat call) rather than through
 * any UI, since none exists for a device's own status reads.
 *
 * The "role gate" dimension does not map onto this route family the way it
 * does for a staff-facing route: a device-bearer actor has no role at all —
 * it authenticates as itself (`requireDeviceBearerAuth()`), not as a tenant
 * member with a rank, so there is no staff/admin/owner ladder to test here.
 * Per the task's own framing, the equivalent hardening dimension this plan's
 * own acceptance criteria call out is that a device can only ever read its
 * OWN station's data — never another station's, and (structurally, since a
 * device's `tenantId` is resolved solely from its own bearer token with no
 * route param/query to override it) never another tenant's either. That is
 * the isolation test below, standing in for the staff role-gate test the
 * other route family gets.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const SEEDED_PASSWORD = "Password123!";

async function signUp(
  page: import("@playwright/test").Page,
  { name, email, slug }: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
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

async function findMemberId(
  page: import("@playwright/test").Page,
  slug: string,
  email: string,
): Promise<string> {
  const res = await page.request.get(`${API_URL}/rpc/customers`, {
    params: { pageSize: "100" },
    headers: { "x-tenant-slug": slug },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; email: string }[] };
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

async function findStationId(
  page: import("@playwright/test").Page,
  slug: string,
  name: string,
): Promise<string> {
  const res = await page.request.get(`${API_URL}/rpc/stations`, {
    params: { q: name, pageSize: "10" },
    headers: { "x-tenant-slug": slug },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; name: string }[] };
  const station = body.items.find((s) => s.name === name);
  expect(station).toBeDefined();
  return station!.id;
}

async function startSessionAsStaff(
  page: import("@playwright/test").Page,
  slug: string,
  stationId: string,
  memberId: string,
): Promise<void> {
  const res = await page.request.post(`${API_URL}/rpc/sessions`, {
    data: { stationId, memberId },
    headers: { "x-tenant-slug": slug },
  });
  expect(res.ok()).toBeTruthy();
}

/**
 * Pairs, auths, and approves a device onto a brand-new station — the same
 * sequence `devices/devices.spec.ts`'s happy path exercises via the UI.
 * Returns everything a device-bearer call needs (`deviceToken`,
 * `fingerprint`) plus the station it was linked to.
 */
async function setupApprovedDevice(
  page: import("@playwright/test").Page,
  base: string,
  branchName: string,
  uniq: string,
): Promise<{ deviceToken: string; fingerprint: string; stationName: string; stationId: string }> {
  const slug = new URL(base).hostname.split(".")[0]!;
  const tokenName = `${faker.word.adjective()} Setup Token`;
  const fingerprint = faker.string.alphanumeric(32).toLowerCase();
  const hostname = `PC-${uniq}-${faker.string.numeric(3)}`;
  const groupName = `Group ${uniq}`;
  const stationName = `${faker.word.noun()} Station ${uniq}`;
  const stationNumber = faker.string.numeric(3);

  // `startSession()` (session/service.ts) 400s "This station has no pricing
  // group" for any station with a null `stationGroupId` — which is exactly
  // what the approve dialog's own "New Station" shortcut creates (no group
  // field on that form at all). `devices/devices.spec.ts`'s own happy path
  // never starts a session, so it never hits this; this spec does, so the
  // station must be pre-created WITH a priced group (mirroring
  // `stations/station-control.spec.ts`'s `setupBoardFixture`) and then
  // linked via the approve dialog's "Existing Station" mode instead.
  await page.goto(`${base}/admin/stations`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("tab", { name: "Manage Stations" }).click();
  await page.getByRole("tab", { name: "Groups & Rates" }).click();
  await page.getByRole("button", { name: "Add Group" }).click();
  await page.getByLabel("Name *").fill(groupName);
  await page.getByLabel("Code *").fill(`G${uniq}`.slice(0, 12));
  await page.getByLabel("Hourly Rate ($) *").fill("10.00");
  await page.getByRole("button", { name: "Create group" }).click();
  await expect(page.getByText("Group created.")).toBeVisible();

  await page.getByRole("tab", { name: "Manage Stations" }).click();
  await page.getByRole("button", { name: "Add Station" }).click();
  await page.getByLabel("Number *").fill(stationNumber);
  await page.getByLabel("Name *").fill(stationName);
  await page.getByRole("combobox", { name: "Group" }).click();
  await page.getByRole("option", { name: groupName }).click();
  await page.getByRole("button", { name: "Create station" }).click();
  await expect(page.getByText("Station created.")).toBeVisible();
  const stationId = await findStationId(page, slug, stationName);

  await page.goto(`${base}/admin/devices`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: /Generate Pairing Code/i }).click();
  await page.getByRole("combobox", { name: /Branch/i }).click();
  await page.getByRole("option", { name: branchName }).click();
  await page.getByLabel("Name *").fill(tokenName);
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByText("Enter this pairing code on the device")).toBeVisible();
  const pairingCodeText = await page.locator(".select-all").textContent();
  const pairingCode = pairingCodeText?.trim() || "";
  await page.getByRole("button", { name: "Done" }).click();

  const pairRes = await page.request.post(`${API_URL}/api/v1/device/pair`, {
    data: { pairingCode },
  });
  expect(pairRes.ok()).toBeTruthy();
  const { provisioningToken } = (await pairRes.json()) as { provisioningToken: string };

  const authRes = await page.request.post(`${API_URL}/api/v1/device/auth`, {
    data: { provisioningToken, fingerprint, hostname },
  });
  expect(authRes.status()).toBe(201);
  const { deviceToken } = (await authRes.json()) as { deviceToken: string };

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(hostname)).toBeVisible();
  // The approve dialog defaults to "Existing Station" mode (devices/page.tsx's
  // `approveMode` initial state) — no need to click that toggle explicitly.
  // The `<Label>Station</Label>` here has no `htmlFor` pairing (unlike the
  // "Add Station" form's `Group` combobox above), so a name-based
  // `getByRole("combobox", { name: ... })` lookup is not reliable for it;
  // this dialog has exactly one combobox, so it is targeted positionally
  // instead — NOT independently re-verified against a live app in this pass
  // (flagged in the phase report).
  await page.getByRole("button", { name: "Approve" }).click();
  const approveDialog = page.getByRole("dialog");
  await approveDialog.getByRole("combobox").click();
  await page.getByRole("option", { name: `${stationNumber}: ${stationName}` }).click();
  await page.getByRole("button", { name: "Approve Device" }).click();
  await expect(page.getByText("Device approved")).toBeVisible();

  return { deviceToken, fingerprint, stationName, stationId };
}

test.describe("Device-facing session & wallet status", () => {
  test("happy path: a paired device reads its own station's active session and wallet balance", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2edevstat${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    await signUp(page, { name: faker.person.fullName(), email: ownerEmail, slug });
    await createBranch(page, base, branchName);
    const { deviceToken, fingerprint, stationId } = await setupApprovedDevice(
      page,
      base,
      branchName,
      uniq,
    );

    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, {
      name: faker.person.fullName(),
      email: customerEmail,
    });
    await ctxCust.close();

    const memberId = await findMemberId(page, slug, customerEmail);
    await topUpWallet(page, slug, memberId, "50.00");
    await startSessionAsStaff(page, slug, stationId, memberId);

    const sessionRes = await page.request.get(`${API_URL}/api/v1/device/session/active`, {
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        "X-Device-Fingerprint": fingerprint,
      },
    });
    expect(sessionRes.ok()).toBeTruthy();
    const sessionBody = (await sessionRes.json()) as {
      session: { memberId: string; status: string } | null;
    };
    expect(sessionBody.session).not.toBeNull();
    expect(sessionBody.session!.memberId).toBe(memberId);
    expect(sessionBody.session!.status).toBe("active");

    const walletRes = await page.request.get(`${API_URL}/api/v1/device/wallet/balance`, {
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        "X-Device-Fingerprint": fingerprint,
      },
    });
    expect(walletRes.ok()).toBeTruthy();
    const walletBody = (await walletRes.json()) as { balance: string | null; currency?: string };
    expect(walletBody.balance).toBe("50.00");
  });

  test("cross-station/cross-tenant isolation: a device can only ever read its own station's data", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2edevstatiso${uniq}`;
    const slugOther = `e2edevstatisob${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const otherOwnerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const baseOther = `http://${slugOther}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;
    const branchNameOther = `${faker.company.name()} Other Branch`;

    // Tenant A: two approved devices/stations. Only station A1 ever gets a
    // session + a funded member.
    await signUp(page, { name: faker.person.fullName(), email: ownerEmail, slug });
    await createBranch(page, base, branchName);
    const deviceA1 = await setupApprovedDevice(page, base, branchName, `${uniq}a1`);
    const deviceA2 = await setupApprovedDevice(page, base, branchName, `${uniq}a2`);

    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, {
      name: faker.person.fullName(),
      email: customerEmail,
    });
    await ctxCust.close();
    const memberId = await findMemberId(page, slug, customerEmail);
    await topUpWallet(page, slug, memberId, "75.00");
    await startSessionAsStaff(page, slug, deviceA1.stationId, memberId);

    // Tenant B: one approved device/station, wholly unrelated tenant, no
    // session ever created there.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: faker.person.fullName(), email: otherOwnerEmail, slug: slugOther });
    await createBranch(pageB, baseOther, branchNameOther);
    const deviceB1 = await setupApprovedDevice(pageB, baseOther, branchNameOther, `${uniq}b1`);

    // Device A1 (the station WITH the session) sees it — sanity check the
    // fixture is real before asserting the negatives below.
    const a1Res = await page.request.get(`${API_URL}/api/v1/device/session/active`, {
      headers: {
        Authorization: `Bearer ${deviceA1.deviceToken}`,
        "X-Device-Fingerprint": deviceA1.fingerprint,
      },
    });
    const a1Body = (await a1Res.json()) as { session: { memberId: string } | null };
    expect(a1Body.session?.memberId).toBe(memberId);

    // Device A2 — same TENANT, different STATION, never had a session — must
    // read null, never A1's session or wallet. This is the station-scoping
    // guarantee `status-routes.ts`'s own doc comment calls out: `device.
    // stationId` is the only station identifier either handler ever reads.
    const a2SessionRes = await page.request.get(`${API_URL}/api/v1/device/session/active`, {
      headers: {
        Authorization: `Bearer ${deviceA2.deviceToken}`,
        "X-Device-Fingerprint": deviceA2.fingerprint,
      },
    });
    expect(a2SessionRes.ok()).toBeTruthy();
    expect(((await a2SessionRes.json()) as { session: unknown }).session).toBeNull();

    const a2WalletRes = await page.request.get(`${API_URL}/api/v1/device/wallet/balance`, {
      headers: {
        Authorization: `Bearer ${deviceA2.deviceToken}`,
        "X-Device-Fingerprint": deviceA2.fingerprint,
      },
    });
    expect(a2WalletRes.ok()).toBeTruthy();
    expect(((await a2WalletRes.json()) as { balance: unknown }).balance).toBeNull();

    // Device B1 — a DIFFERENT TENANT entirely. There is no route param or
    // query string a device call could use to even attempt to name tenant
    // A's station — `device.tenantId`/`device.stationId` come solely from
    // the bearer token resolved server-side (`resolveDeviceAuthContext`) — so
    // this is a structural, not merely policy, guarantee. Confirmed here
    // anyway: B1 reads null, never A1's session/wallet.
    const b1SessionRes = await pageB.request.get(`${API_URL}/api/v1/device/session/active`, {
      headers: {
        Authorization: `Bearer ${deviceB1.deviceToken}`,
        "X-Device-Fingerprint": deviceB1.fingerprint,
      },
    });
    expect(b1SessionRes.ok()).toBeTruthy();
    expect(((await b1SessionRes.json()) as { session: unknown }).session).toBeNull();

    const b1WalletRes = await pageB.request.get(`${API_URL}/api/v1/device/wallet/balance`, {
      headers: {
        Authorization: `Bearer ${deviceB1.deviceToken}`,
        "X-Device-Fingerprint": deviceB1.fingerprint,
      },
    });
    expect(b1WalletRes.ok()).toBeTruthy();
    expect(((await b1WalletRes.json()) as { balance: unknown }).balance).toBeNull();

    await ctxB.close();
  });
});
