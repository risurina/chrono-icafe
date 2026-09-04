import { test, expect } from "@playwright/test";

/**
 * Browser coverage for the platform System Health surface (`/admin/health`,
 * `GET /rpc-admin/system-health` + `/system-health/events`, spec #17).
 * Observational and read-only — the platform-admin equivalent of the tenant
 * happy/role/isolation triad:
 *  - happy path: the dashboard renders live component status;
 *  - role gate: every platform role reads it (read-only), a non-platform actor
 *    is refused (403);
 *  - honesty: a component with no real probe (Payment when billing is off)
 *    renders "Not configured", never "Operational".
 *
 * Same conventions as `metrics.spec.ts` — real dev DB, `platform@agora.test`
 * (seeded platformRole: "admin") and `platform-viewer@agora.test` (viewer) as
 * the acting staff. Requires `pnpm dev` running (the Playwright config declares
 * no webServer).
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const PLATFORM_VIEWER_EMAIL = "platform-viewer@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

async function signInStaff(
  page: import("@playwright/test").Page,
  host: string,
  email: string,
) {
  await page.goto(`http://${host}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
    timeout: 15_000,
  });
}

test.describe("Platform System Health", () => {
  test("a platform admin sees the overall banner and per-component status", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    await page.goto("http://localtest.me:3000/admin/health");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: "System health" }),
    ).toBeVisible();
    await expect(page.getByText("Components")).toBeVisible();
    // Real probes render as operational.
    const dbRow = page.getByText("Database", { exact: true });
    await expect(dbRow).toBeVisible();
    await expect(page.getByText("Operational").first()).toBeVisible();
    await expect(page.getByText("Recent system events")).toBeVisible();
  });

  test("every platform role reads it, a non-platform actor is refused", async ({
    page,
  }) => {
    // A viewer (read-only platform role) can read the surface.
    await signInStaff(page, "localtest.me:3000", PLATFORM_VIEWER_EMAIL);
    const asViewer = await page.request.get(`${API_URL}/rpc-admin/system-health`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(asViewer.status()).toBe(200);

    // A signed-in user with no platform role is blocked.
    await page.goto("http://localtest.me:3000/login");
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill("owner@acme.test");
    await page.getByLabel("Password").fill(SEEDED_PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), {
      timeout: 15_000,
    });
    const asOrdinary = await page.request.get(
      `${API_URL}/rpc-admin/system-health`,
    );
    expect(asOrdinary.status()).toBe(403);
    const eventsOrdinary = await page.request.get(
      `${API_URL}/rpc-admin/system-health/events`,
    );
    expect(eventsOrdinary.status()).toBe(403);
  });

  test("Payment reports not_configured (never a fabricated green) when billing is off", async ({
    page,
  }) => {
    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const res = await page.request.get(`${API_URL}/rpc-admin/system-health`, {
      headers: { "x-platform-admin": "1" },
    });
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      components: { key: string; status: string }[];
    };
    const payment = body.components.find((c) => c.key === "payment");
    // Honest status: with billing off, this is not_configured, not operational.
    expect(payment).toBeTruthy();
    expect(["not_configured", "not_applicable"]).toContain(payment!.status);
    expect(payment!.status).not.toBe("operational");

    const cache = body.components.find((c) => c.key === "cache");
    expect(cache!.status).toBe("not_applicable");
  });
});
