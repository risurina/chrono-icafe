import { test, expect, type Page } from "@playwright/test";
import WebSocket from "ws";
import { faker } from "../../utils/faker";
import {
  startRealtimeTestServer,
  type RealtimeTestServer,
} from "../../utils/realtime-test-publish";

/**
 * Coverage for realtime-updates Phase 3 (`.ai/plans/chrono/active/
 * realtime-updates/README.md`) — the device channel (`/api/v1/device/ws`).
 *
 * Same manual-suite caveat as `station-updates.spec.ts`: requires the
 * developer's own `chrono-api` dev process stopped first, since
 * `startRealtimeTestServer()` binds the same port.
 *
 * Uses the real `ws` npm client directly (NOT a browser `WebSocket` via
 * `page.evaluate`) because a real kiosk device sets an `Authorization`
 * bearer header + `X-Device-Fingerprint` header on its upgrade request — a
 * browser `WebSocket` cannot set custom headers at all, so this is the only
 * way to exercise the real device credential path end-to-end. Playwright
 * test files run in Node, so importing `ws` directly here is normal (mirrors
 * `apps/chrono-api/src/modules/device/realtime-actor.test.ts`'s own backend
 * test, which does the same thing one layer down).
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const WS_URL = API_URL.replace(/^http/, "ws");
const SEEDED_PASSWORD = "Password123!";

async function signUp(
  page: Page,
  { name, email, slug }: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Full name").fill(name);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Business name").fill(slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function createBranch(page: Page, base: string, name: string): Promise<void> {
  await page.goto(`${base}/dashboard/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(name)).toBeVisible();
}

async function resolveTenantId(page: Page, slug: string): Promise<string> {
  const me = await page.evaluate(async (s) => {
    const api = location.origin.replace(/:3000$/, ":8787");
    const res = await fetch(`${api}/rpc/me`, {
      credentials: "include",
      headers: { "x-tenant-slug": s },
    });
    return res.ok ? ((await res.json()) as { tenantId: string }) : null;
  }, slug);
  if (!me) throw new Error("Failed to resolve tenantId for the business.");
  return me.tenantId;
}

/**
 * Pairs a device through the real dashboard + REST pairing flow (mirrors
 * `apps/chrono-web/e2e/tests/devices/devices.spec.ts`'s own happy path),
 * approves it via the dashboard, and returns its bearer credential.
 */
async function pairAndApproveDevice(
  page: Page,
  base: string,
  branchName: string,
): Promise<{
  deviceToken: string;
  fingerprint: string;
  deviceId: string;
  stationId: string;
  stationName: string;
}> {
  const tokenName = `${faker.word.adjective()} Setup Token`;
  const fingerprint = faker.string.alphanumeric(32);
  const hostname = `PC-${faker.string.numeric(3)}`;
  const stationName = `${faker.word.noun()} Station`;
  const stationNumber = faker.string.numeric(3);

  await page.goto(`${base}/dashboard/devices`);
  await page.waitForLoadState("networkidle");

  await page.getByRole("button", { name: /Generate Pairing Code/i }).click();
  await page.getByRole("combobox", { name: /Branch/i }).click();
  await page.getByRole("option", { name: branchName }).click();
  await page.getByLabel("Name *").fill(tokenName);
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByText("Enter this pairing code on the device")).toBeVisible();

  const pairingCode = ((await page.locator(".select-all").textContent()) ?? "").trim();
  expect(pairingCode).toBeTruthy();
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
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "New Station" }).click();
  await page.getByLabel("Station Name *").fill(stationName);
  await page.getByLabel("Station Number *").fill(stationNumber);
  await page.getByRole("button", { name: "Approve Device" }).click();
  await expect(page.getByText("Device approved")).toBeVisible();

  const listRes = await page.request.get(`${API_URL}/rpc/stations`, {
    params: { pageSize: "100" },
  });
  const list = (await listRes.json()) as { items: { id: string; name: string }[] };
  const station = list.items.find((s) => s.name === stationName);
  expect(station).toBeTruthy();

  const deviceListRes = await page.request.get(`${API_URL}/rpc/devices`, {
    params: { pageSize: "100" },
  });
  const deviceList = (await deviceListRes.json()) as { items: { id: string; hostname: string | null }[] };
  const device = deviceList.items.find((d) => d.hostname === hostname);
  expect(device).toBeTruthy();

  return { deviceToken, fingerprint, deviceId: device!.id, stationId: station!.id, stationName };
}

function openDeviceSocket(
  deviceToken: string,
  fingerprint: string,
): Promise<{ ws: WebSocket | null; rejectedStatus: number | null }> {
  return new Promise((resolve) => {
    const socket = new WebSocket(`${WS_URL}/api/v1/device/ws`, {
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "x-device-fingerprint": fingerprint,
      },
    });
    let settled = false;
    socket.once("open", () => {
      if (settled) return;
      settled = true;
      resolve({ ws: socket, rejectedStatus: null });
    });
    socket.once("unexpected-response", (_req, res) => {
      if (settled) return;
      settled = true;
      socket.terminate();
      resolve({ ws: null, rejectedStatus: res.statusCode ?? null });
    });
    socket.once("error", () => {
      if (settled) return;
      settled = true;
      resolve({ ws: null, rejectedStatus: null });
    });
  });
}

test.describe("Realtime device channel", () => {
  let server: RealtimeTestServer;

  test.beforeAll(async () => {
    server = await startRealtimeTestServer();
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test("device gate: a pending_approval device is refused before the handshake completes", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2ertdev${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    await signUp(page, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
      slug,
    });
    await createBranch(page, base, branchName);

    await page.goto(`${base}/dashboard/devices`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /Generate Pairing Code/i }).click();
    await page.getByRole("combobox", { name: /Branch/i }).click();
    await page.getByRole("option", { name: branchName }).click();
    await page.getByLabel("Name *").fill("Pending Token");
    await page.getByRole("button", { name: "Generate" }).click();
    const pairingCode = ((await page.locator(".select-all").textContent()) ?? "").trim();
    await page.getByRole("button", { name: "Done" }).click();

    const pairRes = await page.request.post(`${API_URL}/api/v1/device/pair`, {
      data: { pairingCode },
    });
    const { provisioningToken } = (await pairRes.json()) as { provisioningToken: string };
    const fingerprint = faker.string.alphanumeric(32);
    const authRes = await page.request.post(`${API_URL}/api/v1/device/auth`, {
      data: { provisioningToken, fingerprint, hostname: `PC-${faker.string.numeric(3)}` },
    });
    const { deviceToken } = (await authRes.json()) as { deviceToken: string; status: string };
    // Never approved — device stays pending_approval.

    const { ws, rejectedStatus } = await openDeviceSocket(deviceToken, fingerprint);
    expect(ws).toBeNull();
    expect(rejectedStatus).toBe(403);
  });

  test("an approved device receives events on its own channel; a device never receives another device's events; revocation closes the socket", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8);
    const slug = `e2ertdch${uniq}`;
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    await signUp(page, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
      slug,
    });
    await createBranch(page, base, branchName);
    const tenantId = await resolveTenantId(page, slug);

    const deviceA = await pairAndApproveDevice(page, base, branchName);
    const deviceB = await pairAndApproveDevice(page, base, branchName);
    expect(deviceA.stationId).not.toBe(deviceB.stationId);

    const { ws: wsA, rejectedStatus: rejA } = await openDeviceSocket(
      deviceA.deviceToken,
      deviceA.fingerprint,
    );
    expect(rejA).toBeNull();
    expect(wsA).not.toBeNull();

    const eventsA: { event: string; payload: unknown }[] = [];
    wsA!.on("message", (data) => {
      try {
        eventsA.push(JSON.parse(data.toString()));
      } catch {
        /* ignore */
      }
    });

    // Publish a session.state event scoped to device B's OWN private channel
    // (`device:{deviceId}`, per validateChronoDeviceScopes's grammar — keyed
    // by device id, not stationId) — device A must never see it.
    await server.publishTestEvent(tenantId, `device:${deviceB.deviceId}`, "session.state", {
      sessionId: "fake-session",
      stationId: deviceB.stationId,
      status: "active",
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(eventsA.some((e) => e.event === "session.state")).toBe(false);

    // Publish to device A's own channel — it must receive this one, proving
    // both halves of the isolation boundary (not just "A never sees B").
    await server.publishTestEvent(tenantId, `device:${deviceA.deviceId}`, "session.state", {
      sessionId: "real-session",
      stationId: deviceA.stationId,
      status: "active",
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(
      eventsA.some(
        (e) =>
          e.event === "session.state" &&
          (e.payload as { sessionId?: unknown }).sessionId === "real-session",
      ),
    ).toBe(true);

    // Revoke device A while its socket is open and confirm it closes.
    await page.goto(`${base}/dashboard/devices`);
    await page.waitForLoadState("networkidle");
    const closedPromise = new Promise<void>((resolve) => {
      wsA!.once("close", () => resolve());
    });
    const revokeButtons = page.getByRole("button", { name: "Revoke" });
    await revokeButtons.first().click();
    await page.getByRole("button", { name: "Revoke Device" }).click();
    await expect(page.getByText("Device revoked")).toBeVisible();

    await Promise.race([
      closedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("socket did not close")), 10_000)),
    ]);
    expect(wsA!.readyState).toBe(WebSocket.CLOSED);
  });
});
