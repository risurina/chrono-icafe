import { test, expect, type Page } from "@playwright/test";

/**
 * global-portal-social-login plan, Phase 8 — browser-level coverage for the
 * apex-only global customer portal's social sign-in buttons on
 * `/portal/login` (`GlobalLoginForm`) and `/portal/sign-up`
 * (`GlobalSignUpForm`).
 *
 * Same UI-only scope as `apps/chrono-web/e2e/tests/portal/social-login-ui.spec.ts`
 * (the tenant member portal's own equivalent): no real Google/Facebook
 * consent screen is reachable from this suite — these specs stop at "did the
 * right thing render / did the click navigate to the right URL". The actual
 * OAuth flow correctness (create/reuse/collision/suspended/unavailable/
 * missing-email/cancelled/apply-to-tenant) is proven server-side in
 * `apps/chrono-api/src/e2e/run.ts`'s customer-oauth re-run block.
 *
 * Unlike `MemberSocialSignIn`, `CustomerSocialSignIn` has NO host/subdomain
 * gate at all — it always renders on the apex-only forms — so there is no
 * `parseHost` custom-domain assertion here (that was specific to the tenant
 * member portal's subdomain check).
 *
 * Google/Facebook credentials are not configured in this dev environment
 * (`apps/chrono-api/.env`), so `customerAuth.providers()` genuinely reports
 * `social: []` here — exactly the "hidden, not greyed" case. The first test
 * below exercises that real state directly. The remaining tests stub the
 * `/auth/customer/providers` response to exercise the "buttons render" path
 * without touching real credentials.
 */

const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "localtest.me:3000";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://api.localtest.me:8787";
const APEX_HOST = APP_DOMAIN.split(":")[0];
const APEX_PORT = APP_DOMAIN.includes(":") ? `:${APP_DOMAIN.split(":")[1]}` : "";
const APEX_ORIGIN = `http://${APEX_HOST}${APEX_PORT}`;

const FAKE_PROVIDERS_BODY = {
  email: true,
  social: [
    { id: "google", label: "Google" },
    { id: "facebook", label: "Facebook" },
  ],
};

async function stubProviders(page: Page, body: unknown) {
  await page.route(`${API_URL}/auth/customer/providers`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    }),
  );
}

test.describe("Global customer portal social sign-in — UI", () => {
  test("buttons are hidden (not disabled) when no provider is available", async ({ page }) => {
    // Real, unstubbed state of this dev environment: no OAuth credentials
    // configured, so /auth/customer/providers genuinely reports social: [].
    await page.goto(`${APEX_ORIGIN}/portal/login`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /continue with google/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /continue with facebook/i })).toHaveCount(0);
    // No orphaned "OR" divider, and the password form still renders.
    await expect(page.getByText("OR", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  test("buttons render for available providers on login and sign-up", async ({ page }) => {
    await stubProviders(page, FAKE_PROVIDERS_BODY);

    await page.goto(`${APEX_ORIGIN}/portal/login`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with facebook/i })).toBeVisible();
    await expect(page.getByText("OR", { exact: true })).toBeVisible();

    await page.goto(`${APEX_ORIGIN}/portal/sign-up`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with facebook/i })).toBeVisible();
  });

  test("clicking Continue with Google navigates to the provider start URL", async ({ page }) => {
    await stubProviders(page, FAKE_PROVIDERS_BODY);
    // Stop at the API boundary — no real IdP is reachable from this suite
    // (matches social-login-ui.spec.ts's own stance of asserting the
    // navigation target, not completing the flow).
    await page.route(`${API_URL}/auth/customer/google/start**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
    );

    await page.goto(`${APEX_ORIGIN}/portal/login`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /continue with google/i }).click();
    await page.waitForURL((url) => url.pathname === "/auth/customer/google/start", {
      timeout: 15_000,
    });
    const url = new URL(page.url());
    // Unlike the member-portal version, there is no `?tenant=` param — this
    // pool has no tenant dimension. `next` is the only query param the
    // component appends.
    expect(url.searchParams.get("tenant")).toBeNull();
    expect(url.searchParams.get("next")).toBe("/portal");
  });

  test("a returned ?error= renders the mapped toast on login and sign-up", async ({ page }) => {
    await page.goto(`${APEX_ORIGIN}/portal/login?error=account_not_linked`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/that email is already registered/i).first()).toBeVisible();
    // The form itself must not be left blank/broken.
    await expect(page.getByLabel("Email")).toBeVisible();

    await page.goto(`${APEX_ORIGIN}/portal/sign-up?error=cancelled`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/sign-in was cancelled/i).first()).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
  });
});
