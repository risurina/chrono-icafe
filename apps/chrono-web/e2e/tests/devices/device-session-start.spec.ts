import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Phase 6 e2e coverage for Phase 5 of
 * .ai/plans/chrono/in-progress/pc-client-tauri-api-integration/README.md —
 * `POST /api/v1/device/session/start` (kiosk login -> session start,
 * device-bearer-gated, no chrono-web UI in this pass — the Tauri client's
 * own login form is the only intended caller).
 *
 * Same rationale as `devices/device-status.spec.ts` for calling this route
 * directly via `page.request` (`devices/devices.spec.ts`'s established
 * precedent for a backend-only device-bearer route) and for what stands in
 * for the staff "role gate" dimension here: a device-bearer actor has no
 * role/rank at all, so the equivalent hardening this plan's own acceptance
 * criteria call out is "a device with no linked/approved station cannot
 * start any session" (a device-bearer request that is well-authenticated but
 * structurally incapable of the action, the closest analogue to a
 * well-authenticated-but-unauthorized staff request) — covered below
 * alongside the wrong-credentials and per-device-rate-limit cases the plan's
 * own Phase 5 acceptance criteria name explicitly.
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

/** Look up a station's id by name via the staff list (used to prove the
 * pre-created, priced station is what the device ends up linked to). */
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

/** `startSession()` (session/service.ts) 422s "Insufficient wallet balance"
 * for a zero-balance member with no eligible credit grant, so the happy-path
 * test below must fund the customer's wallet before the kiosk login attempt
 * — mirrors `stations/station-control.spec.ts`'s own `topUpWallet` helper. */
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

/** Pairs + auths a device WITHOUT approving it — left in `pending_approval`. */
async function pairAndAuthDevice(
  page: import("@playwright/test").Page,
  base: string,
  branchName: string,
  uniq: string,
): Promise<{ deviceToken: string; fingerprint: string; hostname: string }> {
  const tokenName = `${faker.word.adjective()} Setup Token`;
  const fingerprint = faker.string.alphanumeric(32).toLowerCase();
  const hostname = `PC-${uniq}-${faker.string.numeric(3)}`;

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

  return { deviceToken, fingerprint, hostname };
}

/** Pairs, auths, and approves a device onto a brand-new station. */
/**
 * Pairs, auths, and approves a device onto a PRE-CREATED, priced station —
 * `startSession()` (session/service.ts) 400s "This station has no pricing
 * group" for a bare station with no `stationGroupId`, which is exactly what
 * the approve dialog's own "New Station" shortcut creates. This spec starts
 * real sessions, so the station is created first (mirroring
 * `stations/station-control.spec.ts`'s `setupBoardFixture`) and then linked
 * via the approve dialog's default "Existing Station" mode.
 */
async function setupApprovedDevice(
  page: import("@playwright/test").Page,
  base: string,
  branchName: string,
  uniq: string,
): Promise<{ deviceToken: string; fingerprint: string }> {
  const slug = new URL(base).hostname.split(".")[0]!;
  const groupName = `Group ${uniq}`;
  const stationName = `${faker.word.noun()} Station ${uniq}`;
  const stationNumber = faker.string.numeric(3);

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
  await findStationId(page, slug, stationName);

  const { deviceToken, fingerprint, hostname } = await pairAndAuthDevice(
    page,
    base,
    branchName,
    uniq,
  );

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(hostname)).toBeVisible();
  // Defaults to "Existing Station" mode (devices/page.tsx's `approveMode`
  // initial state). The `<Label>Station</Label>` here has no `htmlFor`
  // pairing, so the combobox is targeted positionally (this dialog has
  // exactly one) rather than by accessible name — NOT independently
  // re-verified against a live app in this pass (flagged in the phase
  // report).
  await page.getByRole("button", { name: "Approve" }).click();
  const approveDialog = page.getByRole("dialog");
  await approveDialog.getByRole("combobox").click();
  await page.getByRole("option", { name: `${stationNumber}: ${stationName}` }).click();
  await page.getByRole("button", { name: "Approve Device" }).click();
  await expect(page.getByText("Device approved")).toBeVisible();

  return { deviceToken, fingerprint };
}

test.describe("Kiosk login -> session start", () => {
  test("happy path: a customer starts a session at the kiosk with email + password", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2edevsess${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    await signUp(page, { name: faker.person.fullName(), email: ownerEmail, slug });
    await createBranch(page, base, branchName);
    const { deviceToken, fingerprint } = await setupApprovedDevice(page, base, branchName, uniq);

    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, {
      name: faker.person.fullName(),
      email: customerEmail,
    });
    await ctxCust.close();
    const memberId = await findMemberId(page, slug, customerEmail);
    await topUpWallet(page, slug, memberId, "50.00");

    const startRes = await page.request.post(`${API_URL}/api/v1/device/session/start`, {
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        "X-Device-Fingerprint": fingerprint,
      },
      data: { memberEmail: customerEmail, memberPassword: SEEDED_PASSWORD },
    });
    expect(startRes.status()).toBe(201);
    const startBody = (await startRes.json()) as {
      session: { status: string; stationId: string };
    };
    expect(startBody.session.status).toBe("active");

    // Confirm it is real, not just a 201 — the device's own session/active
    // read (Phase 4) now reports the same session as active.
    const activeRes = await page.request.get(`${API_URL}/api/v1/device/session/active`, {
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        "X-Device-Fingerprint": fingerprint,
      },
    });
    const activeBody = (await activeRes.json()) as { session: { status: string } | null };
    expect(activeBody.session?.status).toBe("active");
  });

  test("wrong credentials are refused generically (401), never leaking which field was wrong", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2edevsesswrong${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    await signUp(page, { name: faker.person.fullName(), email: ownerEmail, slug });
    await createBranch(page, base, branchName);
    const { deviceToken, fingerprint } = await setupApprovedDevice(page, base, branchName, uniq);

    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, {
      name: faker.person.fullName(),
      email: customerEmail,
    });
    await ctxCust.close();

    // Wrong password, real email.
    const wrongPasswordRes = await page.request.post(
      `${API_URL}/api/v1/device/session/start`,
      {
        headers: {
          Authorization: `Bearer ${deviceToken}`,
          "X-Device-Fingerprint": fingerprint,
        },
        data: { memberEmail: customerEmail, memberPassword: "definitely-wrong-1" },
      },
    );
    expect(wrongPasswordRes.status()).toBe(401);
    const wrongPasswordBody = (await wrongPasswordRes.json()) as { error: string };

    // Unknown email entirely.
    const unknownEmailRes = await page.request.post(`${API_URL}/api/v1/device/session/start`, {
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        "X-Device-Fingerprint": fingerprint,
      },
      data: {
        memberEmail: faker.internet.email({ provider: "example.com" }),
        memberPassword: SEEDED_PASSWORD,
      },
    });
    expect(unknownEmailRes.status()).toBe(401);
    const unknownEmailBody = (await unknownEmailRes.json()) as { error: string };

    // Both failure modes collapse to the same generic message — never
    // distinguishable, per the plan's own acceptance criterion.
    expect(unknownEmailBody.error).toBe(wrongPasswordBody.error);
  });

  test("a device with no linked/approved station cannot start any session (404)", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2edevsessunlinked${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const customerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    await signUp(page, { name: faker.person.fullName(), email: ownerEmail, slug });
    await createBranch(page, base, branchName);
    // Paired + authed, deliberately left pending_approval (never linked to a
    // station) — this is the well-authenticated-but-structurally-incapable
    // case standing in for the staff role-gate dimension on this
    // device-bearer route family (see the file-level comment above).
    const { deviceToken, fingerprint } = await pairAndAuthDevice(page, base, branchName, uniq);

    const ctxCust = await browser.newContext();
    const pageCust = await ctxCust.newPage();
    await portalSignUp(pageCust, base, {
      name: faker.person.fullName(),
      email: customerEmail,
    });
    await ctxCust.close();

    const res = await page.request.post(`${API_URL}/api/v1/device/session/start`, {
      headers: {
        Authorization: `Bearer ${deviceToken}`,
        "X-Device-Fingerprint": fingerprint,
      },
      data: { memberEmail: customerEmail, memberPassword: SEEDED_PASSWORD },
    });
    expect(res.status()).toBe(404);
  });

  test("the per-device rate limit trips independently of the per-account one", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2edevsessrl${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    await signUp(page, { name: faker.person.fullName(), email: ownerEmail, slug });
    await createBranch(page, base, branchName);
    const { deviceToken, fingerprint } = await setupApprovedDevice(page, base, branchName, uniq);

    // `deviceSessionLoginLimiter` is a per-device bucket (20/15min,
    // status-routes.ts) shared across every distinct customer who tries this
    // ONE kiosk — deliberately wider than the per-account bucket, so a run of
    // wrong guesses against many DIFFERENT unknown emails from this one
    // device must still eventually trip it. Loop with a hard cap well past
    // the documented threshold rather than asserting the exact trip point,
    // since this test only needs to prove the limiter exists and fires, not
    // pin its internal counting semantics.
    let sawRateLimited = false;
    let lastStatus = 0;
    for (let i = 0; i < 30 && !sawRateLimited; i++) {
      const res = await page.request.post(`${API_URL}/api/v1/device/session/start`, {
        headers: {
          Authorization: `Bearer ${deviceToken}`,
          "X-Device-Fingerprint": fingerprint,
        },
        data: {
          memberEmail: faker.internet.email({ provider: "example.com" }),
          memberPassword: "definitely-wrong",
        },
      });
      lastStatus = res.status();
      if (lastStatus === 429) {
        sawRateLimited = true;
        expect(res.headers()["retry-after"]).toBeTruthy();
      } else {
        expect(lastStatus).toBe(401);
      }
    }
    expect(sawRateLimited).toBe(true);
  });
});
