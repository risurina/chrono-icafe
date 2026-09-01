import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Browser + API coverage for the platform audit log's filter controls and
 * CSV export (`/admin/audit`, `GET /rpc-admin/audit`, `GET /rpc-admin/audit/export`).
 *
 * A light spec, not the full happy-path/role-gate/isolation trio — this table
 * has no tenant dimension at all (`platform_audit_event` is explicitly not
 * RLS-scoped), so there is no cross-tenant isolation case to assert. See the
 * plan's Phase 5 for the full reasoning.
 *
 * This suite reaches into the database directly for test 2/3's bulk fixture
 * rows, following the exact precedent established by
 * `apps/web/e2e/tests/impersonation/impersonation-expiry.spec.ts`:
 * `loadApiEnv()` loads the running API's own `apps/api/.env` into this Node
 * process, then imports `agora/db` directly for a scoped `adminDb` write
 * against the non-RLS-scoped `platform_audit_event` table. Every synthetic
 * row is tagged with a uniquely-prefixed `action` value and removed again in
 * `afterAll`.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

function loadApiEnv() {
  const envPath = path.resolve(__dirname, "../../../../api/.env");
  const raw = readFileSync(envPath, "utf8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

async function signInStaff(page: Page, host: string, email: string) {
  await page.goto(`http://${host}/login`);
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

async function signUpWorkspace(
  page: Page,
  opts: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Workspace name").fill(opts.slug);
  await page.getByRole("button", { name: /create workspace/i }).click();
  await page.waitForURL(new RegExp(`//${opts.slug}\\.localtest\\.me:3000/dashboard`), {
    timeout: 60_000,
  });
}

async function findOrgAndOwner(adminPage: Page, slug: string) {
  const orgsRes = await adminPage.request.get(
    `${API_URL}/rpc-admin/organizations?search=${slug}`,
    { headers: { "x-platform-admin": "1" } },
  );
  const orgsBody = (await orgsRes.json()) as { items: { id: string }[] };
  const orgId = orgsBody.items[0]?.id;
  expect(orgId).toBeTruthy();
  const membersRes = await adminPage.request.get(
    `${API_URL}/rpc-admin/organizations/${orgId}/members`,
    { headers: { "x-platform-admin": "1" } },
  );
  const membersBody = (await membersRes.json()) as {
    items: { userId: string; role: string }[];
  };
  const owner = membersBody.items.find((m) => m.role === "owner");
  expect(owner).toBeTruthy();
  return { orgId: orgId!, ownerUserId: owner!.userId };
}

/** Minimal RFC-4180-aware CSV parser — good enough for this test's fixture data
 * (no embedded newlines expected in the synthetic rows below), used only to
 * count matching field occurrences rather than a naive `split("\n")`. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const EXPORT_CAP_TAG = `test.audit-export-cap.${Date.now()}`;
const SMALL_EXPORT_TAG = `test.audit-export-small.${Date.now()}`;

test.describe("Platform audit log — filters and export", () => {
  test.afterAll(async () => {
    loadApiEnv();
    const { adminDb, schema, ilike } = await import("agora/db");
    await adminDb
      .delete(schema.platformAuditEvent)
      .where(ilike(schema.platformAuditEvent.action, "test.audit-export%"));
  });

  test("a viewer can filter the audit log by action and only matching rows render", async ({
    page,
    browser,
  }) => {
    const uniq = Date.now();
    const slug = `test-auditflt${uniq}`;
    const ownerEmail = `test-auditflt-owner${uniq}@example.com`;
    await signUpWorkspace(page, { name: "Audit Filter Owner", email: ownerEmail, slug });

    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    await signInStaff(adminPage, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const { orgId, ownerUserId } = await findOrgAndOwner(adminPage, slug);

    // Produce real platform.tenant.suspended / .resumed rows via a direct,
    // authenticated request to the existing suspend/resume routes.
    const suspendRes = await adminPage.request.post(
      `${API_URL}/rpc-admin/organizations/${orgId}/suspend`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(suspendRes.ok()).toBeTruthy();
    const resumeRes = await adminPage.request.post(
      `${API_URL}/rpc-admin/organizations/${orgId}/resume`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(resumeRes.ok()).toBeTruthy();

    // Grant the throwaway org's owner a "viewer" platform role — the
    // narrower of the two roles, both of which hold audit:read — then sign
    // in as that viewer for the filter assertion.
    const grantRes = await adminPage.request.patch(
      `${API_URL}/rpc-admin/staff/${ownerUserId}/role`,
      { headers: { "x-platform-admin": "1" }, data: { role: "viewer" } },
    );
    expect(grantRes.ok()).toBeTruthy();

    try {
      await page.goto("http://localtest.me:3000/login");
      await page.waitForLoadState("networkidle");
      await page.getByLabel("Email").fill(ownerEmail);
      await page.getByLabel("Password").fill(SEEDED_PASSWORD);
      await page.getByRole("button", { name: /sign in/i }).click();
      await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
        timeout: 15_000,
      });

      await page.goto("http://localtest.me:3000/admin/audit");
      await page.waitForLoadState("networkidle");
      await page.getByPlaceholder("Action contains…").fill("suspended");
      await page.waitForURL(/action=suspended/, { timeout: 10_000 });
      await expect(page.getByText("platform.tenant.suspended").first()).toBeVisible();
      await expect(page.getByText("platform.tenant.resumed")).toHaveCount(0);
    } finally {
      await adminPage.request.patch(`${API_URL}/rpc-admin/staff/${ownerUserId}/role`, {
        headers: { "x-platform-admin": "1" },
        data: { role: null },
      });
    }
  });

  test("exporting more rows than the cap is rejected with a clear message and no file", async ({
    page,
  }) => {
    loadApiEnv();
    const { adminDb, schema } = await import("agora/db");
    const { PLATFORM_AUDIT_EXPORT_MAX_ROWS } = await import("agora");

    const rowCount = PLATFORM_AUDIT_EXPORT_MAX_ROWS + 1;
    const rows = Array.from({ length: rowCount }, () => ({
      actorId: null,
      actorLabel: "test-fixture",
      action: EXPORT_CAP_TAG,
      targetType: null,
      targetId: null,
      targetLabel: null,
      metadata: null,
      ip: null,
      createdAt: new Date(),
    }));
    // Batched insert, not one row at a time.
    const BATCH = 1000;
    for (let i = 0; i < rows.length; i += BATCH) {
      await adminDb.insert(schema.platformAuditEvent).values(rows.slice(i, i + BATCH));
    }

    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const res = await page.request.get(
      `${API_URL}/rpc-admin/audit/export?action=${encodeURIComponent(EXPORT_CAP_TAG)}`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(
      `Narrow your filters — ${rowCount} rows match, the export limit is ${PLATFORM_AUDIT_EXPORT_MAX_ROWS}.`,
    );
  });

  test("exporting a small filtered set returns a valid CSV with the matching row count", async ({
    page,
  }) => {
    loadApiEnv();
    const { adminDb, schema } = await import("agora/db");
    const KNOWN_COUNT = 3;
    await adminDb.insert(schema.platformAuditEvent).values(
      Array.from({ length: KNOWN_COUNT }, () => ({
        actorId: null,
        actorLabel: "test-fixture",
        action: SMALL_EXPORT_TAG,
        targetType: null,
        targetId: null,
        targetLabel: null,
        metadata: null,
        ip: null,
        createdAt: new Date(),
      })),
    );

    await signInStaff(page, "localtest.me:3000", PLATFORM_ADMIN_EMAIL);
    const res = await page.request.get(
      `${API_URL}/rpc-admin/audit/export?action=${encodeURIComponent(SMALL_EXPORT_TAG)}`,
      { headers: { "x-platform-admin": "1" } },
    );
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["content-type"]).toContain("text/csv");

    const body = await res.text();
    const parsed = parseCsv(body);
    const [header, ...dataRows] = parsed;
    expect(header).toBeDefined();
    const actionIndex = header!.indexOf("action");
    const matching = dataRows.filter((r) => r[actionIndex] === SMALL_EXPORT_TAG);
    expect(matching).toHaveLength(KNOWN_COUNT);
  });
});
