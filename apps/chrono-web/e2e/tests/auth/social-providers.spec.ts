import { test, expect } from "@playwright/test";

/**
 * Browser coverage for platform sign-in methods and the social sign-in surface.
 *
 * Like the rest of `apps/web/e2e`, this is MANUAL: the Playwright config runs
 * headed against real dev servers (`pnpm dev`) and declares no `webServer`.
 *
 * The IdP hop itself is out of reach here — no real Google consent screen — so
 * these specs cover what the browser genuinely owns: that the sign-in pages
 * render exactly the methods the platform offers, that the platform admin page
 * enforces the invariants visibly, and that the zero-workspace apex user is
 * routed to workspace creation instead of a dead end. The gate behind those
 * screens is proven in `apps/api/src/e2e/run.ts`.
 *
 * Each test restores whatever it toggled, because this suite runs
 * `fullyParallel: false, workers: 1` against the shared dev database and a
 * disabled sign-in method would poison every spec that follows.
 */
const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const SEEDED_PASSWORD = "Password123!";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

type ProviderState = {
  id: string;
  enabled: boolean;
  configured: boolean;
  available: boolean;
  label: string;
};

async function signIn(
  page: import("@playwright/test").Page,
  email: string,
  password = SEEDED_PASSWORD,
) {
  await page.goto("/login");
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: /^sign in$/i }).click();
  // Wait for the post-auth redirect to land before the caller navigates again —
  // otherwise a goto() right after click() can race the session cookie write
  // and land back on /login.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 15_000,
  });
}

/** Read the platform's provider states through the admin API, as the admin. */
async function readProviders(
  page: import("@playwright/test").Page,
): Promise<ProviderState[]> {
  const body = await page.evaluate(async (apiUrl) => {
    const res = await fetch(`${apiUrl}/rpc-admin/auth-providers`, {
      credentials: "include",
      headers: { "x-platform-admin": "1" },
    });
    return res.json();
  }, API_URL);
  return body.providers as ProviderState[];
}

/** Set a provider's flag directly, for setup/teardown rather than assertions. */
async function setProvider(
  page: import("@playwright/test").Page,
  id: string,
  enabled: boolean,
): Promise<number> {
  return page.evaluate(
    async ({ apiUrl, id, enabled }) => {
      const res = await fetch(`${apiUrl}/rpc-admin/auth-providers/${id}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "x-platform-admin": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify({ enabled }),
      });
      return res.status;
    },
    { apiUrl: API_URL, id, enabled },
  );
}

test.describe("Platform sign-in methods", () => {
  test("the admin page lists every method with its availability", async ({ page }) => {
    await signIn(page, PLATFORM_ADMIN_EMAIL);
    await page.goto("/admin/auth-providers");
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByRole("heading", { name: /sign-in methods/i }),
    ).toBeVisible();
    await expect(page.getByText("Email & password")).toBeVisible();
    await expect(page.getByText("Google", { exact: true })).toBeVisible();
    await expect(page.getByText("Facebook", { exact: true })).toBeVisible();
  });

  test("the only remaining method cannot be switched off", async ({ page }) => {
    await signIn(page, PLATFORM_ADMIN_EMAIL);
    await page.goto("/admin/auth-providers");
    await page.waitForLoadState("networkidle");

    const providers = await readProviders(page);
    const available = providers.filter((p) => p.available);
    test.skip(
      available.length !== 1 || available[0]!.id !== "email",
      "This assertion only holds when email is the single available method.",
    );

    // The server is the authority; the UI must agree with it rather than
    // offering a control that is guaranteed to be refused.
    await expect(
      page.getByRole("switch", { name: /toggle email & password sign-in/i }),
    ).toBeDisabled();
    await expect(
      page.getByText(/only sign-in method left/i),
    ).toBeVisible();

    // And the API refuses it even if the control is bypassed.
    expect(await setProvider(page, "email", false)).toBe(400);
  });

  test("a disabled method disappears from the sign-in page", async ({ page }) => {
    await signIn(page, PLATFORM_ADMIN_EMAIL);
    await page.goto("/admin/auth-providers");
    await page.waitForLoadState("networkidle");

    const before = await readProviders(page);
    const google = before.find((p) => p.id === "google");
    test.skip(
      !google?.configured,
      "Needs GOOGLE_AUTH_KEY / GOOGLE_AUTH_SECRET configured in apps/api/.env.",
    );

    try {
      expect(await setProvider(page, "google", true)).toBe(200);
      await page.goto("/login");
      await page.waitForLoadState("networkidle");
      await expect(
        page.getByRole("button", { name: /continue with google/i }),
      ).toBeVisible();

      await page.goto("/admin/auth-providers");
      await page.waitForLoadState("networkidle");
      expect(await setProvider(page, "google", false)).toBe(200);

      await page.goto("/login");
      await page.waitForLoadState("networkidle");
      await expect(
        page.getByRole("button", { name: /continue with google/i }),
      ).toHaveCount(0);
    } finally {
      // Restore whatever the platform started with.
      await page.goto("/admin/auth-providers");
      await page.waitForLoadState("networkidle");
      await setProvider(page, "google", google!.enabled);
    }
  });

  test("an ordinary staff account cannot reach the admin page", async ({ page }) => {
    await signIn(page, "owner@acme.test");
    await page.goto("/admin/auth-providers");
    // The shell redirects anyone without a platform role away.
    await page.waitForURL((url) => !url.pathname.startsWith("/admin"), {
      timeout: 15_000,
    });
    expect(page.url()).not.toContain("/admin");
  });
});

test.describe("Post-authentication routing", () => {
  test("a user with no workspace lands on workspace creation, not a dead end", async ({
    page,
  }) => {
    // The platform admin deliberately holds no tenant membership, which makes
    // it the exact case that used to be sent to /dashboard on a tenant-less
    // host and see nothing.
    await signIn(page, PLATFORM_ADMIN_EMAIL);
    await page.waitForURL(/\/(new-workspace|admin|dashboard)/, { timeout: 20_000 });
    expect(page.url()).toContain("/new-workspace");
    await expect(
      page.getByRole("heading", { name: /welcome — create your workspace/i }),
    ).toBeVisible();
  });

  test("the callback surfaces account_not_linked as an actionable message", async ({
    page,
  }) => {
    // Better Auth hands this back when implicit linking is refused — always for
    // Facebook, and for Google when the local account is not email-verified.
    // It is an expected outcome, so it must not read as a generic failure.
    await page.goto("/auth/callback?error=account_not_linked");
    await page.waitForLoadState("networkidle");
    await expect(
      page.getByText(/link this provider from settings/i),
    ).toBeVisible();
  });
});
