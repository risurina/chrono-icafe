import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Phase 6 e2e coverage for Phase 3 of
 * .ai/plans/chrono/in-progress/pc-client-tauri-api-integration/README.md —
 * `GET`/`POST /rpc/devices/:id/commands` (staff-facing, `device:manage`-gated,
 * admin+ only).
 *
 * There is deliberately no chrono-web UI for command dispatch in this pass
 * (the plan's Open Question 3 resolved this REST-only — the Tauri client is
 * the only consumer). Following the established precedent for testing a
 * backend-only route with no UI in this suite — `devices/devices.spec.ts`'s
 * own use of the Playwright `request`/`page.request` fixture to call
 * `/api/v1/device/*` directly rather than clicking through a UI that doesn't
 * exist — this spec calls `/rpc/devices/:id/commands` directly via
 * `page.request`, which carries the signed-in staff session cookie
 * automatically; `x-tenant-slug` is required on every such direct call since,
 * per `stations/station-control.spec.ts`'s documented finding, a raw
 * `page.request` call to a different origin (`API_URL`) has no tenant context
 * of its own the way the browser's `tenantFetch()` client does.
 *
 * The realtime push-and-ack round trip (`device.command` frame out,
 * `command-ack` frame back) needs a live WebSocket device connection, which
 * is exactly what the plan's own Phase 6 manual smoke test covers
 * (pairing -> approve -> heartbeat -> realtime connect -> command
 * round-trip) — not reproducible from Playwright's HTTP-only `request`
 * fixture. This spec covers the REST issue/list surface, the role gate, and
 * cross-tenant isolation only.
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

async function findInviteLink(toEmail: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const DEV_LOG_PATH = process.env.DEV_LOG_PATH ?? "/tmp/agora-dev.log";
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
  throw new Error(`Invite link not found for ${toEmail} in ${DEV_LOG_PATH}`);
}

/**
 * Generates a pairing code via the UI, pairs + auths a simulated device
 * against it, then approves the device onto a brand-new station via the UI —
 * the exact sequence `devices/devices.spec.ts`'s happy-path test already
 * exercises, reused here rather than reinvented. Returns the approved
 * device's own `id` (looked up afterward via `GET /rpc/devices`, since the
 * approve-device UI dialog itself never surfaces the device id).
 */
async function setupApprovedDevice(
  page: import("@playwright/test").Page,
  base: string,
  slug: string,
  branchName: string,
  uniq: string,
): Promise<string> {
  const tokenName = `${faker.word.adjective()} Setup Token`;
  const fingerprint = faker.string.alphanumeric(32).toLowerCase();
  const hostname = `PC-${uniq}-${faker.string.numeric(3)}`;
  const newStationName = `${faker.word.noun()} Station`;
  const newStationNumber = faker.string.numeric(3);

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

  await page.reload();
  await page.waitForLoadState("networkidle");
  await expect(page.getByText(hostname)).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("button", { name: "New Station" }).click();
  await page.getByLabel("Station Name *").fill(newStationName);
  await page.getByLabel("Station Number *").fill(newStationNumber);
  await page.getByRole("button", { name: "Approve Device" }).click();
  await expect(page.getByText("Device approved")).toBeVisible();

  const listRes = await page.request.get(`${API_URL}/rpc/devices`, {
    params: { pageSize: "100" },
    headers: { "x-tenant-slug": slug },
  });
  expect(listRes.ok()).toBeTruthy();
  const body = (await listRes.json()) as { items: { id: string; hostname: string }[] };
  const device = body.items.find((d) => d.hostname === hostname);
  expect(device).toBeDefined();
  return device!.id;
}

test.describe("Device command dispatch", () => {
  test("happy path: an owner issues a command and sees it queued/listed", async ({ page }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2edevcmd${uniq}`;
    const email = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    await signUp(page, { name: faker.person.fullName(), email, slug });
    await createBranch(page, base, branchName);
    const deviceId = await setupApprovedDevice(page, base, slug, branchName, uniq);

    const issueRes = await page.request.post(`${API_URL}/rpc/devices/${deviceId}/commands`, {
      data: { type: "lock" },
      headers: { "x-tenant-slug": slug },
    });
    expect(issueRes.status()).toBe(201);
    const issueBody = (await issueRes.json()) as {
      command: { id: string; type: string; status: string; deviceId: string };
    };
    expect(issueBody.command.type).toBe("lock");
    expect(issueBody.command.deviceId).toBe(deviceId);
    // The in-memory realtime provider's `publish()` never throws even with no
    // connected listener (packages/agora/src/events/realtime/providers/
    // memory.ts) — there is no live device WS connection in this spec, so
    // "delivered" here means "the server attempted the push", exactly as
    // routes.ts's own doc comment for this route describes, not proof a
    // device received it.
    expect(issueBody.command.status).toBe("delivered");

    const listRes = await page.request.get(`${API_URL}/rpc/devices/${deviceId}/commands`, {
      headers: { "x-tenant-slug": slug },
    });
    expect(listRes.ok()).toBeTruthy();
    const listBody = (await listRes.json()) as { items: { id: string; type: string }[] };
    expect(listBody.items.some((c) => c.id === issueBody.command.id && c.type === "lock")).toBe(
      true,
    );
  });

  test("role gate: a staff member is rejected issuing a command (device:manage is admin+ only)", async ({
    page,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `e2edevcmdgate${uniq}`;
    const staffSlug = `e2edevcmdgateinv${uniq}`;
    const ownerEmail = faker.internet.email({ provider: "example.com" });
    const staffEmail = faker.internet.email({ provider: "example.com" });
    const base = `http://${slug}.localtest.me:3000`;
    const branchName = `${faker.company.name()} Branch`;

    await signUp(page, { name: faker.person.fullName(), email: ownerEmail, slug });
    await createBranch(page, base, branchName);
    const deviceId = await setupApprovedDevice(page, base, slug, branchName, uniq);

    // Invite a staff member — the crew-invite flow's default role, confirmed
    // by `reconciliation/role-gate.spec.ts` and `devices/devices.spec.ts`'s
    // own role-gate tests, is `staff`, which per
    // `apps/chrono-api/src/auth/permissions.ts`'s `CHRONO_STAFF_GRANTS` holds
    // NO `device` grant at all (not even `approve`/`revoke`) — `device:manage`
    // is admin+ only.
    await page.goto(`${base}/admin/settings/crew`);
    await page.waitForLoadState("networkidle");
    await page.getByPlaceholder("teammate@example.com").fill(staffEmail);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Invite crew" }).click();
    await expect(page.getByText(staffEmail)).toBeVisible();
    const inviteLink = await findInviteLink(staffEmail);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForLoadState("networkidle");

    await signUp(page, { name: faker.person.fullName(), email: staffEmail, slug: staffSlug });
    await page.goto(inviteLink);
    await expect(page.getByText(/you're in/i)).toBeVisible({ timeout: 15_000 });
    await page.waitForURL(new RegExp(`//${slug}\\.localtest\\.me:3000/admin`), {
      timeout: 15_000,
    });

    const staffIssueRes = await page.request.post(
      `${API_URL}/rpc/devices/${deviceId}/commands`,
      { data: { type: "lock" }, headers: { "x-tenant-slug": slug } },
    );
    expect(staffIssueRes.status()).toBe(403);

    const staffListRes = await page.request.get(`${API_URL}/rpc/devices/${deviceId}/commands`, {
      headers: { "x-tenant-slug": slug },
    });
    expect(staffListRes.status()).toBe(403);
  });

  test("tenant isolation: an admin in tenant B cannot target tenant A's device", async ({
    page,
    browser,
  }) => {
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `e2edevcmda${uniq}`;
    const slugB = `e2edevcmdb${uniq}`;
    const emailA = faker.internet.email({ provider: "example.com" });
    const emailB = faker.internet.email({ provider: "example.com" });
    const baseA = `http://${slugA}.localtest.me:3000`;
    const baseB = `http://${slugB}.localtest.me:3000`;
    const branchNameA = `${faker.company.name()} Branch A`;
    const branchNameB = `${faker.company.name()} Branch B`;

    await signUp(page, { name: faker.person.fullName(), email: emailA, slug: slugA });
    await createBranch(page, baseA, branchNameA);
    const deviceIdA = await setupApprovedDevice(page, baseA, slugA, branchNameA, `${uniq}a`);

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUp(pageB, { name: faker.person.fullName(), email: emailB, slug: slugB });
    await createBranch(pageB, baseB, branchNameB);

    // Tenant B (an owner, so the role gate is not the reason this fails) can
    // never see, let alone command, tenant A's device — `requireOwnDevice`
    // (routes.ts) scopes the lookup by BOTH `id` and the caller's own
    // `tenantId` via `withTenant`, so a cross-tenant `commandId`/`deviceId`
    // 404s rather than leaking existence.
    const crossIssueRes = await pageB.request.post(
      `${API_URL}/rpc/devices/${deviceIdA}/commands`,
      { data: { type: "lock" }, headers: { "x-tenant-slug": slugB } },
    );
    expect(crossIssueRes.status()).toBe(404);

    const crossListRes = await pageB.request.get(
      `${API_URL}/rpc/devices/${deviceIdA}/commands`,
      { headers: { "x-tenant-slug": slugB } },
    );
    expect(crossListRes.status()).toBe(404);

    await ctxB.close();
  });
});
