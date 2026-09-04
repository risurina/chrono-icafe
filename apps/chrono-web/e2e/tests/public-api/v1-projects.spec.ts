import { test, expect } from "@playwright/test";
import { faker } from "../../utils/faker";

/**
 * Browser + API coverage for the public versioned API (`/api/v1`, Phase A of
 * `.ai/plans/agora/archive/generic-multitenant-extensibility/README.md`): API-key
 * auth, the envelope/error shape, cross-tenant isolation, and rate limiting.
 * `/api/v1/projects` and `/api/v1/files` delegate to the same
 * requirePermission/withTenant path as their `/rpc` equivalents — this spec
 * proves the public surface wraps that correctly, not the underlying logic
 * (already covered by the `/rpc` project tests).
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
const SEEDED_PASSWORD = "Password123!";

async function signUpWorkspace(
  page: import("@playwright/test").Page,
  opts: { name: string; email: string; slug: string },
) {
  await page.goto("/sign-up");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1500);
  await page.getByLabel("Your name").fill(opts.name);
  await page.getByLabel("Email").fill(opts.email);
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByLabel("Business name").fill(opts.slug);
  await page.getByRole("button", { name: /create business/i }).click();
  await page.waitForURL(new RegExp(`//${opts.slug}\\.localtest\\.me:3000/admin`), {
    timeout: 60_000,
  });
}

/** Mint an API key for the signed-in tenant via the existing /rpc/api-keys route. */
async function mintApiKey(page: import("@playwright/test").Page): Promise<string> {
  const res = await page.request.post(`${API_URL}/rpc/api-keys`, {
    data: { name: `test-v1-key-${faker.string.alphanumeric(8).toLowerCase()}`, role: "owner" },
  });
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { apiKey: { secret: string } };
  return body.apiKey.secret;
}

test.describe("Public API v1", () => {
  test("API key auth, envelope shape, and cross-tenant isolation", async ({ page, browser }) => {
    test.setTimeout(120_000);
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slugA = `test-v1-a-${uniq}`;
    const slugB = `test-v1-b-${uniq}`;

    await signUpWorkspace(page, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
      slug: slugA,
    });
    const secretA = await mintApiKey(page);

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await signUpWorkspace(pageB, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
      slug: slugB,
    });
    const secretB = await mintApiKey(pageB);

    // No key → 401.
    const noAuth = await page.request.get(`${API_URL}/api/v1/projects`);
    expect(noAuth.status()).toBe(401);

    // Garbage key → 401.
    const badAuth = await page.request.get(`${API_URL}/api/v1/projects`, {
      headers: { Authorization: "Bearer not-a-real-key" },
    });
    expect(badAuth.status()).toBe(401);

    // Happy path: create via v1, envelope shape, then list via v1.
    const projectName = `Test Project ${faker.string.alphanumeric(6).toLowerCase()}`;
    const createRes = await page.request.post(`${API_URL}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${secretA}` },
      data: { name: projectName },
    });
    expect(createRes.status()).toBe(201);
    const created = (await createRes.json()) as {
      data: { id: string; name: string };
      meta: { requestId: string; apiVersion: string };
    };
    expect(created.data.name).toBe(projectName);
    expect(created.meta.apiVersion).toBe("v1");
    expect(created.meta.requestId).toBeTruthy();

    const listRes = await page.request.get(`${API_URL}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${secretA}` },
    });
    expect(listRes.ok()).toBeTruthy();
    const list = (await listRes.json()) as {
      data: { items: { id: string; name: string }[] };
    };
    expect(list.data.items.some((p) => p.id === created.data.id)).toBe(true);

    // Cross-tenant isolation: tenant B's key sees none of tenant A's projects.
    const listAsB = await pageB.request.get(`${API_URL}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${secretB}` },
    });
    expect(listAsB.ok()).toBeTruthy();
    const listB = (await listAsB.json()) as { data: { items: { id: string }[] } };
    expect(listB.data.items.some((p) => p.id === created.data.id)).toBe(false);

    // Delete via v1, then confirm it's gone.
    const deleteRes = await page.request.delete(
      `${API_URL}/api/v1/projects/${created.data.id}`,
      { headers: { Authorization: `Bearer ${secretA}` } },
    );
    expect(deleteRes.ok()).toBeTruthy();
    const relistRes = await page.request.get(`${API_URL}/api/v1/projects`, {
      headers: { Authorization: `Bearer ${secretA}` },
    });
    const relist = (await relistRes.json()) as { data: { items: { id: string }[] } };
    expect(relist.data.items.some((p) => p.id === created.data.id)).toBe(false);

    await ctxB.close();
  });

  test("rate limiting: exceeding the per-tenant budget returns 429", async ({ page }) => {
    test.setTimeout(60_000);
    const uniq = faker.string.alphanumeric(8).toLowerCase();
    const slug = `test-v1-rl-${uniq}`;
    await signUpWorkspace(page, {
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: "example.com" }),
      slug,
    });
    const secret = await mintApiKey(page);

    // Limiter is 60/min per tenant — 65 rapid requests must trip it at least once.
    const results = await Promise.all(
      Array.from({ length: 65 }, () =>
        page.request.get(`${API_URL}/api/v1/projects`, {
          headers: { Authorization: `Bearer ${secret}` },
        }),
      ),
    );
    expect(results.some((r) => r.status() === 429)).toBe(true);
  });
});
