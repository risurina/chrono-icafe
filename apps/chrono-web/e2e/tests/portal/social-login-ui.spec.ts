import { test, expect, type Page } from "@playwright/test";
import { parseHost } from "agora";

/**
 * portal-social-login plan, Phase 6 — browser-level coverage for the member
 * (tenant-scoped `tenantMember`) portal's social sign-in buttons on
 * `/login` (`MemberLoginForm`) and `/portal/sign-up` (`TenantSignUpForm`).
 *
 * Like `apps/chrono-web/e2e/tests/auth/social-providers.spec.ts` (the staff
 * pool's own equivalent), no real Google/Facebook consent screen is reachable
 * from this suite — these specs stop at "did the right thing render / did
 * the click navigate to the right URL". The actual OAuth flow correctness
 * (create/reuse/cross-tenant/collision/suspended/unavailable/missing-email/
 * cancelled) is proven server-side in `apps/chrono-api/src/e2e/run.ts`.
 *
 * Google/Facebook credentials are not configured in this dev environment
 * (`apps/chrono-api/.env`), so `memberAuth.providers()` genuinely reports
 * `social: []` here — exactly the "hidden, not greyed" case (foundation
 * plan D4). The first test below exercises that real state directly. The
 * remaining tests stub the `/portal/auth/providers` response to exercise the
 * "buttons render" path without touching real credentials.
 *
 * Uses the `gaming` tenant seeded by `apps/chrono-api/src/seed.ts` — the one
 * fixture with both a subdomain (`gaming.<APP_DOMAIN>`) and a verified
 * custom domain (`chrono2.izur.com.ph`, a real internet domain per
 * `apps/chrono-api/AGENTS.md`, never resolvable to this dev server).
 *
 * D6 ("hidden on a verified custom domain") note: `MemberSocialSignIn`
 * (`packages/agora/src/presentation/ui/components/custom/member-social-sign-in.tsx`)
 * decides this ENTIRELY from one client-side call —
 * `parseHost(window.location.host, ...).kind !== "subdomain"` — with no
 * server round trip. Spoofing a real third-party domain's Host header to
 * drive a full page load against the local Next.js dev server was tried
 * (`page.route()` proxying `chrono2.izur.com.ph` through to `localhost:3000`
 * with a rewritten Host header, so no real DNS/network access ever left this
 * machine) but Next 15's dev-only `allowedDevOrigins` cross-origin guard
 * 403s every `/_next/static/*` chunk request whose Host doesn't match an
 * allowed dev origin, so the page never hydrates past "Loading…" — a dev
 * server security feature working as intended, not something to weaken for
 * a test. So D6 is proven as two complementary facts instead: this same
 * `parseHost` call classifies `chrono2.izur.com.ph` as `kind: "custom"` (not
 * `"subdomain"`) — asserted directly below, against the exact function and
 * the exact seeded hostname — and the "buttons render for an available
 * provider" test proves the OTHER branch of that same conditional (a real
 * `subdomain` host) renders them. Together they cover both sides of the one
 * branch the component takes.
 */

const GAMING_SLUG = "gaming";
const GAMING_CUSTOM_DOMAIN = "chrono2.izur.com.ph";
const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "localtest.me:3000";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://api.localtest.me:8787";

const FAKE_PROVIDERS_BODY = {
  email: true,
  social: [
    { id: "google", label: "Google" },
    { id: "facebook", label: "Facebook" },
  ],
};

async function stubProviders(page: Page, body: unknown) {
  await page.route(`${API_URL}/portal/auth/providers`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    }),
  );
}

test.describe("Member portal social sign-in — UI", () => {
  test("buttons are hidden (not disabled) when no provider is available", async ({ page }) => {
    // Real, unstubbed state of this dev environment: no OAuth credentials
    // configured, so /portal/auth/providers genuinely reports social: [].
    await page.goto(`http://${GAMING_SLUG}.localtest.me:3000/login`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /continue with google/i })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /continue with facebook/i })).toHaveCount(0);
    // No orphaned "OR" divider, and the password form still renders.
    await expect(page.getByText("OR", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  test("buttons render for available providers on login and sign-up (D6's subdomain branch)", async ({
    page,
  }) => {
    await stubProviders(page, FAKE_PROVIDERS_BODY);

    await page.goto(`http://${GAMING_SLUG}.localtest.me:3000/login`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with facebook/i })).toBeVisible();
    await expect(page.getByText("OR", { exact: true })).toBeVisible();

    await page.goto(`http://${GAMING_SLUG}.localtest.me:3000/portal/sign-up`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: /continue with google/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /continue with facebook/i })).toBeVisible();
  });

  test("clicking Continue with Google navigates to the provider start URL", async ({ page }) => {
    await stubProviders(page, FAKE_PROVIDERS_BODY);
    // Stop at the API boundary — no real IdP is reachable from this suite
    // (matches social-providers.spec.ts's own stance of asserting the
    // navigation target, not completing the flow).
    await page.route(`${API_URL}/portal/auth/google/start**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/plain", body: "" }),
    );

    await page.goto(`http://${GAMING_SLUG}.localtest.me:3000/login`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /continue with google/i }).click();
    await page.waitForURL((url) => url.pathname === "/portal/auth/google/start", {
      timeout: 15_000,
    });
    const url = new URL(page.url());
    expect(url.searchParams.get("tenant")).toBe(GAMING_SLUG);
  });

  test("a returned ?error= renders the mapped toast on login and sign-up", async ({ page }) => {
    await page.goto(`http://${GAMING_SLUG}.localtest.me:3000/login?error=account_not_linked`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/that email is already registered/i).first()).toBeVisible();
    // The form itself must not be left blank/broken.
    await expect(page.getByLabel("Email")).toBeVisible();

    await page.goto(`http://${GAMING_SLUG}.localtest.me:3000/portal/sign-up?error=cancelled`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText(/sign-in was cancelled/i).first()).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
  });

  test("D6: parseHost classifies gaming's subdomain and its verified custom domain differently", () => {
    // The other half of D6 (see the file header) — the exact function and
    // exact seeded hostname MemberSocialSignIn's render guard depends on.
    const subdomain = parseHost(`${GAMING_SLUG}.localtest.me`, APP_DOMAIN);
    expect(subdomain).toEqual({ kind: "subdomain", slug: GAMING_SLUG });

    const custom = parseHost(GAMING_CUSTOM_DOMAIN, APP_DOMAIN);
    expect(custom.kind).toBe("custom");
    expect(custom.kind).not.toBe("subdomain");
  });
});
