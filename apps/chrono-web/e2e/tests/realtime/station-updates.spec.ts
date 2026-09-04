import { test, expect, type Page } from "@playwright/test";
import { faker } from "../../utils/faker";
import {
  startRealtimeTestServer,
  type RealtimeTestServer,
} from "../../utils/realtime-test-publish";

/**
 * Browser coverage for realtime-updates Phase 1/2a
 * (`.ai/plans/chrono/active/realtime-updates/README.md`) — the staff
 * dashboard's `branch:{id}` subscription and `station.status` emit points.
 *
 * MANUAL suite, same as every other spec in `apps/chrono-web/e2e/`: headed,
 * `slowMo`, no `webServer` in `playwright.config.ts`. UNLIKE every other spec
 * here, this one requires the developer's own separately-running `chrono-api`
 * (`pnpm dev`'s API half) to be STOPPED before running this file —
 * `startRealtimeTestServer()` boots its own replacement bound to the same
 * port, so it can publish directly into the in-process realtime provider (no
 * test-publish HTTP route exists, by websocket-foundation's own design
 * decision — see `apps/chrono-api/src/e2e/realtime-test-server.ts`). The web
 * half of `pnpm dev` (`:3000`) stays running normally.
 *
 * A raw `new WebSocket(...)` inside `page.evaluate` is used (not
 * `connectRealtime()`) for the same reason `apps/agora-web`'s own realtime
 * spec does — it exercises the real `/rpc/realtime` route end-to-end without
 * depending on the client wrapper's own reconnect state machine.
 */

const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

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
  await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });
}

async function createBranch(page: Page, base: string, name: string): Promise<string> {
  await page.goto(`${base}/admin/branches`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Add Branch" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create branch" }).click();
  await expect(page.getByText(name)).toBeVisible();

  const res = await page.request.get(`${API_URL}/rpc/branches`, {
    params: { pageSize: "100" },
    headers: { "x-tenant-slug": new URL(base).hostname.split(".")[0]! },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { items: { id: string; name: string }[] };
  const branch = body.items.find((b) => b.name === name);
  expect(branch).toBeTruthy();
  return branch!.id;
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
 * Opens a raw websocket at `/rpc/realtime` from inside the page and exposes
 * a `window.__rt` handle the test can poll — real end-to-end wire behavior.
 */
async function openRealtimeSocket(page: Page, opts?: { scope?: string }) {
  await page.evaluate((scope) => {
    const api = location.origin.replace(/^http/, "ws").replace(":3000", ":8787");
    const params = new URLSearchParams({ tenantSlug: location.hostname.split(".")[0]! });
    if (scope) params.append("scope", scope);
    const ws = new WebSocket(`${api}/rpc/realtime?${params.toString()}`);
    const events: { event: string; payload: unknown }[] = [];
    ws.addEventListener("message", (evt) => {
      try {
        events.push(JSON.parse(evt.data as string));
      } catch {
        /* ignore malformed test noise */
      }
    });
    (window as unknown as { __rt: unknown }).__rt = { ws, events };
  }, opts?.scope);
}

async function waitForOpen(page: Page, timeoutMs = 5000): Promise<boolean> {
  return page
    .waitForFunction(
      () => (window as unknown as { __rt?: { ws: WebSocket } }).__rt?.ws.readyState === 1,
      undefined,
      { timeout: timeoutMs },
    )
    .then(() => true)
    .catch(() => false);
}

/**
 * Waits for a received event whose payload's fields match every key in
 * `expectedFields` (strict equality per field). Deliberately data-driven
 * (a plain serializable object), never a function passed into
 * `page.evaluate`/`waitForFunction` — a closure capturing outer test
 * variables (like `branchId`) cannot survive that boundary; only JSON-
 * serializable arguments can.
 */
async function receivedEventMatching(
  page: Page,
  eventName: string,
  expectedFields: Record<string, unknown>,
  timeoutMs: number,
): Promise<boolean> {
  return page
    .waitForFunction(
      ({ name, fields }: { name: string; fields: Record<string, unknown> }) => {
        const events =
          (window as unknown as { __rt?: { events: { event: string; payload: unknown }[] } }).__rt
            ?.events ?? [];
        return events.some((e) => {
          if (e.event !== name) return false;
          const payload = e.payload as Record<string, unknown> | null;
          if (typeof payload !== "object" || payload === null) return false;
          return Object.entries(fields).every(([key, value]) => payload[key] === value);
        });
      },
      { name: eventName, fields: expectedFields },
      { timeout: timeoutMs },
    )
    .then(() => true)
    .catch(() => false);
}


test.describe("Realtime station updates", () => {
  let server: RealtimeTestServer;

  test.beforeAll(async () => {
    server = await startRealtimeTestServer();
  });

  test.afterAll(async () => {
    await server.stop();
  });

  test("staff subscribed to a branch receives station.status when a station is created", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2ert${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;
    const stationName = "Realtime Station";
    const stationNumber = faker.string.numeric(3);

    await signUp(page, { name: faker.person.fullName(), email, slug });
    const branchId = await createBranch(page, base, branchName);

    await page.goto(`${base}/admin/stations`);
    await page.waitForLoadState("networkidle");
    await openRealtimeSocket(page, { scope: `branch:${branchId}` });
    expect(await waitForOpen(page)).toBe(true);

    // Trigger the real publish path by creating a station through the actual
    // dashboard flow — not a direct test-publish call — proving Phase 2a's
    // wiring, not just the transport.
    await page.getByRole("tab", { name: "Stations" }).click();
    await page.getByRole("button", { name: "Add Station" }).click();
    await page.getByLabel("Number *").fill(stationNumber);
    await page.getByLabel("Name *").fill(stationName);
    await page.getByRole("button", { name: "Create station" }).click();
    await expect(page.getByText("Station created.")).toBeVisible();

    const gotStationEvent = await receivedEventMatching(
      page,
      "station.status",
      { branchId, status: "available" },
      5000,
    );
    expect(gotStationEvent).toBe(true);

    // branch.summary's payload has counts as a nested object, which
    // top-level strict-field matching can't reach — read the raw events
    // directly for this one assertion instead.
    const gotSummaryEvent = await page
      .waitForFunction(
        (bId: string) => {
          type SummaryPayload = { branchId: string; counts: { available: number } };
          const events =
            (window as unknown as { __rt?: { events: { event: string; payload: unknown }[] } }).__rt
              ?.events ?? [];
          return events.some((e) => {
            if (e.event !== "branch.summary") return false;
            const p = e.payload as SummaryPayload;
            return p.branchId === bId && p.counts.available === 1;
          });
        },
        branchId,
        { timeout: 5000 },
      )
      .then(() => true)
      .catch(() => false);
    expect(gotSummaryEvent).toBe(true);
  });

  test("tenant isolation: a publish to another tenant's branch channel never arrives", async ({
    page,
    browser,
  }) => {
    const uniqA = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2erta${uniqA}`;
    const baseA = `http://${slugA}.localtest.me:3000`;

    await signUp(page, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
      slug: slugA,
    });
    const branchIdA = await createBranch(page, baseA, `${faker.company.name()} Branch`);

    const bContext = await browser.newContext();
    const bPage = await bContext.newPage();
    const uniqB = faker.string.alphanumeric(8).toLowerCase();
    const slugB = `e2ertb${uniqB}`;
    const baseB = `http://${slugB}.localtest.me:3000`;
    await signUp(bPage, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
      slug: slugB,
    });
    const branchIdB = await createBranch(bPage, baseB, `${faker.company.name()} Branch`);
    const tenantIdB = await resolveTenantId(bPage, slugB);
    await bContext.close();

    expect(branchIdA).not.toBe(branchIdB);

    await page.goto(`${baseA}/admin/stations`);
    await page.waitForLoadState("networkidle");
    await openRealtimeSocket(page, { scope: `branch:${branchIdA}` });
    expect(await waitForOpen(page)).toBe(true);

    await server.publishTestEvent(tenantIdB, `branch:${branchIdB}`, "station.status", {
      stationId: "fake-station",
      branchId: branchIdB,
      status: "available",
    });

    // Bounded wait — the event must NOT arrive on tenant A's socket. An
    // empty expected-fields object matches any station.status event.
    const leaked = await receivedEventMatching(page, "station.status", {}, 2000);
    expect(leaked).toBe(false);
  });
});
