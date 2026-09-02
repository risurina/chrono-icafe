import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  auth,
  ForbiddenError,
  resolveAuthProviders,
  resolvePlatformSettings,
  readPlatformRoleByUserId,
} from "agora/auth";
import {
  HttpError,
  resolveOrgFromRequest,
  createRateLimiter,
  clientIp,
  userAgent,
  requestLogger,
  getLogger,
  captureError,
  metrics,
  metricsHandler,
  zValidator,
  normalizeAuthPath,
  getStorage,
  localAssetPath,
} from "agora/server";
import { readFile } from "node:fs/promises";
import { createMemberAuthRoutes } from "agora/member-auth";
import { createCustomerAuthRoutes, createCustomerApplyRoutes } from "agora/customer-auth";
import { checkReadiness } from "agora/health";
import { withAdmin, withTenant, eq, count, inArray } from "agora/db";
import {
  createId,
  acceptInviteSchema,
  AUTH_PROVIDERS,
  AUTH_PROVIDER_IDS,
  isAuthProviderId,
  type AuthProviderId,
} from "agora";
import {
  PlanRequiredError,
  PortalNotSupportedError,
  getBillingProviderId,
  getBillingWebhookProvider,
} from "agora/billing";
import { rpc, lifecycle, signFileForTenant, confirmFileForTenant } from "./routes/rpc";
import { apiV1 } from "./routes/api-v1";
import { deviceAuthRoutes } from "./modules/device/routes";
import {
  tenantBranding,
  tenantSsoConnection,
  tenantSecurityPolicy,
  tenantNotification,
} from "./db/schema";
import { acceptInvite } from "agora/invites";
import { recordAudit, recordPlatformAuditFailure } from "agora/audit";
import { emitTenantEvent } from "agora/webhooks";
import { recheckDomains } from "agora/domains";
import { applyWebhookEvent, recordTransactionEvent } from "agora/billing/server";
import {
  platformAdminRoutes,
  appReportsRoutes,
  appMetricsRoutes,
  appUsageRoutes,
  appFilesRoutes,
} from "agora/platform-admin/routes";
import { project } from "./db/schema";
import { memberPortalRoutes } from "./modules/member/portal-routes";
import { walletPortalRoutes } from "./modules/wallet/portal-routes";
import { creditPortalRoutes } from "./modules/credit/portal-routes";

const webOrigins = (process.env.WEB_ORIGIN ?? "http://localhost:3000")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Map a Better Auth request to the sign-in method it would exercise, or null if
 * it exercises none.
 *
 * `email` covers the WHOLE password credential, not just the sign-in call:
 * password reset and change re-establish exactly the credential an operator
 * just switched off, and the two-factor endpoints only ever complete a password
 * sign-in. Leaving any of them open would make "email disabled" a lie.
 *
 * Social requests carry the provider in the JSON body (`sign-in/social`,
 * `link-social`, and the ID-token variants that share that body) or in the path
 * (`callback/:provider`).
 */
async function providerForAuthRequest(
  method: string,
  path: string,
  raw: Request,
): Promise<AuthProviderId | null> {
  const p = path.replace(/\/+$/, "");

  const callback = /\/callback\/([^/?]+)$/.exec(p);
  if (callback) {
    const id = decodeURIComponent(callback[1]!);
    return isAuthProviderId(id) ? id : null;
  }

  if (method !== "POST") return null;

  const passwordPaths = [
    "/sign-in/email",
    "/sign-up/email",
    "/forget-password",
    "/reset-password",
    "/change-password",
  ];
  if (passwordPaths.some((s) => p.endsWith(s))) return "email";
  if (p.includes("/reset-password/") || p.includes("/two-factor/")) return "email";
  // Not gated, deliberately: /verify-email establishes no session while
  // `autoSignInAfterVerification` is off (it is unset, i.e. false, in
  // packages/agora/src/auth/index.ts). If that is ever turned on, map it to
  // "email" here — otherwise it becomes a way in past a disabled method.

  if (p.endsWith("/sign-in/social") || p.endsWith("/link-social")) {
    try {
      // Clone: the original body must stay unread for auth.handler(c.req.raw).
      // NEVER use c.req.json() here — that consumes the Hono-cached body.
      const body = (await raw.clone().json()) as { provider?: unknown };
      const id = typeof body?.provider === "string" ? body.provider : null;
      return id && isAuthProviderId(id) ? id : null;
    } catch {
      // Unparseable body — let Better Auth reject it with its own error.
      return null;
    }
  }

  return null;
}

// Per-IP throttles for staff credential endpoints (Better Auth).
const staffSignInLimiter = createRateLimiter(5, 15 * 60 * 1000, "staff-signin"); // 5 / 15min
const staffSignUpLimiter = createRateLimiter(10, 60 * 60 * 1000, "staff-signup"); // 10 / hour

// Platform Maintenance / global read-only enforcement (System Settings, spec
// #14), shared by both tenant surfaces: the internal `/rpc/*` client and the
// public `/api/v1/*` surface. See the `.use("/rpc/*", ...)` call site for the
// full rationale (fail-open, platform-admin exemption, break-glass env var).
async function maintenanceReadOnlyGate(c: Context, next: () => Promise<void>) {
  const settings = await resolvePlatformSettings();
  const maintenance = settings["maintenance.mode"] === true;
  const readOnly = settings["danger.readOnlyMode"] === true;
  if (!maintenance && !readOnly) return next();
  if (!maintenance && readOnly && c.req.method === "GET") return next();
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session?.user) {
    const role = await readPlatformRoleByUserId(session.user.id);
    if (role) return next();
  }
  if (maintenance) {
    const message =
      typeof settings["maintenance.message"] === "string"
        ? (settings["maintenance.message"] as string)
        : "The platform is undergoing maintenance.";
    return c.json({ error: message }, 503);
  }
  return c.json({ error: "The platform is in read-only mode." }, 423);
}

// Local-provider branding uploads are served read-only from this dir (relative to
// the API cwd, matching packages/agora storage.ts). S3/R2 providers serve assets
// straight from the bucket, so this route is simply inert for them.
const uploadsDir = process.env.STORAGE_LOCAL_DIR ?? ".uploads";

// Storage keys are server-generated (`${folder}/${fileId}`), but the local
// upload/download routes take one back from the client (a ticket the browser
// echoes), so refuse anything that could escape the uploads directory.
function isSafeLocalKey(key: string): boolean {
  return key.length > 0 && !key.startsWith("/") && !key.split("/").includes("..");
}

// Allow the explicit origins plus any tenant subdomain of the app root.
const rootDomain = (process.env.APP_DOMAIN ?? "").split(":")[0];
const isDev = process.env.NODE_ENV !== "production";
function corsOrigin(origin: string): string | null {
  if (!origin) return null;
  if (webOrigins.includes(origin)) return origin;
  try {
    const host = new URL(origin).hostname;
    // Dev convenience: allow localhost/127.0.0.1 (any port) so the app also
    // works from http://localhost:3000, not just the localtest.me family.
    if (isDev && (host === "localhost" || host === "127.0.0.1")) return origin;
    if (rootDomain && (host === rootDomain || host.endsWith(`.${rootDomain}`))) {
      return origin;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

/**
 * App-owned `project` counts, injected into the foundation's metrics/usage
 * platform-admin routes so they can report per-tenant project counts without the
 * foundation importing this app's schema. `project` is RLS-forced, so the read
 * goes through `withAdmin` (never a bare `adminDb` query). Omitting `tenantIds`
 * counts across all tenants; passing them filters the read.
 */
const projectCountsByTenant = async (
  tenantIds?: readonly string[],
): Promise<Map<string, number>> => {
  const rows = await withAdmin((tx) =>
    tx
      .select({ tenantId: project.tenantId, total: count() })
      .from(project)
      .where(
        tenantIds && tenantIds.length > 0
          ? inArray(project.tenantId, [...tenantIds])
          : undefined,
      )
      .groupBy(project.tenantId),
  );
  return new Map(rows.map((r) => [r.tenantId, r.total]));
};

/**
 * The Hono application. Kept separate from the server bootstrap (index.ts) so
 * it can be imported by tests or an app that attaches WebSockets later.
 */
export const app = new Hono()
  // Correlation id + structured per-request access log. First so every request
  // (including CORS preflights and errors) gets an id and a timing line.
  .use("*", requestLogger())
  // Prometheus request counter + latency histogram (labeled by route pattern).
  .use("*", metrics())
  .use(
    "*",
    cors({
      origin: (origin) => corsOrigin(origin),
      credentials: true,
      allowHeaders: [
        "Content-Type",
        "x-tenant-slug",
        "x-tenant-host",
        "x-platform-admin",
        "x-upload-key",
        "x-upload-content-type",
      ],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  )
  .get("/health", (c) => c.json({ ok: true }))
  // Deep readiness probe for load balancers / deploy gates: checks the DB is
  // reachable (no external-provider calls, no per-tenant data) and answers 503
  // when it is not, so an unready instance is pulled from rotation. Distinct
  // from the shallow `/health` liveness above. Unauthenticated but non-sensitive.
  .get("/health/ready", async (c) => {
    const readiness = await checkReadiness();
    return c.json(
      {
        ok: readiness.ok,
        database: {
          status: readiness.database.status,
          responseTimeMs: readiness.database.responseTimeMs,
        },
      },
      readiness.ok ? 200 : 503,
    );
  })
  // Prometheus scrape endpoint (optionally gated by METRICS_TOKEN). Exposes
  // only method/route/status series — never tenant data.
  .get("/metrics", metricsHandler)
  // The local `StorageAdapter`'s dev-fallback upload/download proxy — the
  // counterpart to the S3/Cloudinary presigned-upload flow when
  // `STORAGE_PROVIDER=local`. `signUpload`/`signedDownloadUrl` in
  // `packages/agora/src/server/storage.ts` mint tickets pointing here; this is
  // a plain (not cryptographically signed) dev fallback, matching that file's
  // documented "may proxy bytes; acceptable and documented" stance — never used
  // in production, where STORAGE_PROVIDER is s3/cloudinary.
  .put("/api/upload/local", async (c) => {
    const key = c.req.header("x-upload-key");
    const contentType = c.req.header("x-upload-content-type") ?? "application/octet-stream";
    if (!key || !isSafeLocalKey(key)) {
      throw new HttpError(400, "Invalid or missing upload key.");
    }
    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File)) {
      throw new HttpError(400, "Missing file part.");
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    await getStorage().put({ key, bytes, contentType });
    return c.json({ ok: true });
  })
  .get("/api/download/local", async (c) => {
    const key = c.req.query("key");
    const expires = Number(c.req.query("expires"));
    if (!key || !isSafeLocalKey(key)) {
      throw new HttpError(400, "Invalid or missing key.");
    }
    if (!Number.isFinite(expires) || Date.now() / 1000 > expires) {
      throw new HttpError(403, "This download link has expired.");
    }
    const bytes = await readFile(localAssetPath(key)).catch(() => null);
    if (!bytes) {
      throw new HttpError(404, "File not found.");
    }
    return c.body(bytes, 200, { "content-type": "application/octet-stream" });
  })
  // Read-only static serving for locally-stored branding assets (GET/HEAD only).
  .use(
    "/uploads/*",
    serveStatic({
      root: uploadsDir,
      rewriteRequestPath: (p) => p.replace(/^\/uploads/, ""),
    }),
  )
  // Refuse any sign-in method the platform has switched off, BEFORE Better Auth
  // sees it. Deliberately a separate middleware from the throttle below: that
  // one early-returns for every non-POST and every non-sign-in path, which
  // would skip the OAuth callback — the single most important route to gate.
  .use("/api/auth/*", async (c, next) => {
    const id = await providerForAuthRequest(
      c.req.method,
      c.req.path,
      c.req.raw,
    );
    if (!id) return next();
    const resolved = await resolveAuthProviders();
    if (!resolved[id].available) {
      // Throw rather than hand-rolling the response, so this failure gets the
      // same shape as every other expected error (.ai/rules/api.md).
      throw new ForbiddenError(`${AUTH_PROVIDERS[id].label} sign-in is not available.`);
    }
    await next();
  })
  // Platform "disable registrations" Danger-Zone toggle (System Settings, spec
  // #14). When on, refuse new account sign-ups AND new workspace creation
  // BEFORE Better Auth sees them. Fail-open on a settings DB error (the
  // resolver returns registry defaults = off), matching the sign-in-method gate
  // above. The break-glass env var (`PLATFORM_SETTINGS_ENFORCEMENT_DISABLED`)
  // short-circuits the resolver entirely.
  .use("/api/auth/*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const p = normalizeAuthPath(c.req.path);
    const isRegistration =
      p.endsWith("/sign-up/email") || p.endsWith("/organization/create");
    if (!isRegistration) return next();
    const settings = await resolvePlatformSettings();
    if (settings["danger.disableRegistrations"] === true) {
      throw new ForbiddenError("New registrations are currently disabled.");
    }
    await next();
  })
  // Throttle staff credential endpoints by IP (only failed attempts count, so a
  // successful login never locks a user out). Applies before Better Auth.
  .use("/api/auth/*", async (c, next) => {
    const isPost = c.req.method === "POST";
    const p = c.req.path;
    const limiter = isPost && p.includes("/sign-in")
      ? staffSignInLimiter
      : isPost && p.includes("/sign-up")
        ? staffSignUpLimiter
        : null;
    if (!limiter) return next();
    const ip = clientIp(c);
    const retryAfter = await limiter.blockedFor(ip);
    if (retryAfter !== null) {
      return c.json({ error: "Too many attempts. Try again later." }, 429, {
        "Retry-After": String(retryAfter),
      });
    }
    await next();
    if (c.res.status >= 400) await limiter.record(ip);
  })
  // Block the Better Auth `admin` plugin's own HTTP surface outright, and
  // deny-by-default the ENTIRE rest of the `/api/auth/*` surface while
  // impersonating (`.ai/plans/agora/archive/tenant-impersonation` Blocker 1).
  // Mounted on the same broad `/api/auth/*` pattern as the gates above —
  // Hono's router pattern-matches BEFORE any handler runs, so a narrower
  // pattern could never be trusted to discriminate a `//`-doubled or encoded
  // path; the decision is made on a normalized path inside the handler
  // instead.
  //
  // The Organization plugin's HTTP surface was the first surface identified
  // (it authorizes off member.role directly and is invisible to the
  // c.var.tenant.permissions strip in getTenantContext()), but Better Auth's
  // own CORE endpoints living directly under /api/auth/ — update-user,
  // change-email, revoke-session(s), delete-user, change-password,
  // two-factor/* — authorize on nothing but a valid session and are exactly
  // as invisible to that strip. Enumerating every mutating core path would
  // fail open the moment the installed better-auth version adds one, so the
  // default while impersonating is deny; only an explicit read-only
  // allowlist stays open.
  .use("/api/auth/*", async (c, next) => {
    const normalized = normalizeAuthPath(c.req.path);

    // This repo's own authorization for start/stop-impersonation is
    // /rpc-admin's requirePlatformPermissionForRequest — the plugin's HTTP
    // routes are never reachable over the wire, under any encoding/slash
    // variant, regardless of session state.
    if (normalized.startsWith("/api/auth/admin/")) {
      throw new HttpError(404, "Not found");
    }

    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    const impersonatedBy = (
      session?.session as { impersonatedBy?: string | null } | undefined
    )?.impersonatedBy;

    // An impersonating platform admin may browse a tenant workspace exactly
    // like the target member, but must never mutate organization
    // membership/settings, the tenant record, or the target's own account
    // (profile, email, password, sessions, 2FA) through Better Auth's HTTP
    // surface — none of that is gated by c.var.tenant.permissions.
    if (impersonatedBy) {
      // Allowlist the few reads that should stay open; block everything else
      // under /api/auth/ by default so a new plugin endpoint added later
      // fails closed. Enumerated from every GET-method endpoint the installed
      // better-auth@1.6.28 organization plugin registers, plus the core
      // session-read endpoints the web app's own session polling relies on.
      const ORG_READ_ONLY_SUFFIXES = [
        "/get-role",
        "/list-roles",
        "/get-active-member-role",
        "/get-active-member",
        "/list-members",
        "/get-invitation",
        "/list-invitations",
        "/list-user-invitations",
        "/list-teams",
        "/list-user-teams",
        "/list-team-members",
        "/get-full-organization",
        "/list",
      ];
      const CORE_READ_ONLY_SUFFIXES = ["/get-session", "/list-sessions"];

      const isOrgPath = normalized.startsWith("/api/auth/organization/");
      const allowlist = isOrgPath ? ORG_READ_ONLY_SUFFIXES : CORE_READ_ONLY_SUFFIXES;
      if (!allowlist.some((suffix) => normalized.endsWith(suffix))) {
        throw new HttpError(404, "Not found");
      }
    }

    await next();
  })
  // Better Auth handles all of /api/auth/* (staff sign-in/up, session, org).
  // Path matches Better Auth's default basePath and the browser client.
  .on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))
  // Customer ("member") auth — separate pool, tenant-scoped.
  .route("/portal/auth", createMemberAuthRoutes())
  // Global customer auth — platform-wide identity, host-independent (see
  // .ai/plans/agora/active/global-customers/README.md).
  .route("/auth/customer", createCustomerAuthRoutes())
  // Self-service "apply to become a customer of this tenant" for a signed-in
  // global customer — tenant-scoped (host-resolved), unlike /auth/customer.
  .route("/portal/customer", createCustomerApplyRoutes())
  // Chrono: customer-facing venue-membership self-service (apply / view own
  // status) — gated by memberMiddleware() inside memberPortalRoutes()
  // itself, mirroring how /portal/auth is mounted directly above.
  .route("/portal/members", memberPortalRoutes())
  // Chrono: customer-facing wallet self-service (balance / history) — gated
  // by memberMiddleware() inside walletPortalRoutes() itself.
  .route("/portal/wallet", walletPortalRoutes())
  // Chrono: customer-facing credit-lot self-service (balance / ledger) —
  // gated by memberMiddleware() inside creditPortalRoutes() itself.
  .route("/portal/credits", creditPortalRoutes())
  // Public: resolve the current host's tenant for the landing page (no auth).
  .get("/public/tenant", async (c) => {
    const org = await resolveOrgFromRequest(c);
    if (!org) return c.json({ tenant: null }, 404);
    return c.json({ tenant: { name: org.name, slug: org.slug } });
  })
  // Public: white-label branding for the current host (pre-auth). Branding is
  // not secret, and this runs before a tenant session exists, so the row is read
  // with `withAdmin` (RLS-bypassing) then narrowed to the public subset — email
  // sender config is never exposed here.
  .get("/public/branding", async (c) => {
    const org = await resolveOrgFromRequest(c);
    if (!org) return c.json({ branding: null }, 404);
    const [row] = await withAdmin((tx) =>
      tx
        .select()
        .from(tenantBranding)
        .where(eq(tenantBranding.tenantId, org.id))
        .limit(1),
    );
    return c.json({
      branding: {
        displayName: row?.displayName ?? null,
        logoUrl: row?.logoUrl ?? null,
        logoDarkUrl: row?.logoDarkUrl ?? null,
        faviconUrl: row?.faviconUrl ?? null,
        primaryColor: row?.primaryColor ?? null,
        accentColor: row?.accentColor ?? null,
        theme: (row?.theme as "system" | "light" | "dark") ?? "system",
        tagline: row?.tagline ?? null,
        supportEmail: row?.supportEmail ?? null,
        customCss: row?.customCss ?? null,
      },
    });
  })
  // Public: does the current host's tenant offer SSO login? (pre-auth hint the
  // /login page uses to show a "Sign in with SSO" button). Reveals only whether
  // SSO is enabled/required — never the connection details or secret. Read with
  // withAdmin because no tenant session exists yet, then narrowed.
  .get("/public/sso", async (c) => {
    const org = await resolveOrgFromRequest(c);
    if (!org) return c.json({ sso: { enabled: false, required: false } });
    const [sso] = await withAdmin((tx) =>
      tx
        .select({ enabled: tenantSsoConnection.enabled })
        .from(tenantSsoConnection)
        .where(eq(tenantSsoConnection.tenantId, org.id))
        .limit(1),
    );
    const [policy] = await withAdmin((tx) =>
      tx
        .select({ ssoRequired: tenantSecurityPolicy.ssoRequired })
        .from(tenantSecurityPolicy)
        .where(eq(tenantSecurityPolicy.tenantId, org.id))
        .limit(1),
    );
    return c.json({
      sso: {
        enabled: sso?.enabled ?? false,
        required: (sso?.enabled ?? false) && (policy?.ssoRequired ?? false),
      },
    });
  })
  // Public: begin an SSO login. Builds the OIDC authorization URL from the
  // tenant's enabled connection (no secret needed for the front-channel
  // redirect) and returns it for the browser to navigate to. NOTE: the IdP
  // callback + code exchange + JIT provisioning are STUBBED in this scaffold
  // (the Better Auth `sso` plugin package is not wired) — see
  // .ai/notes/hardening-backlog.md. This endpoint produces a genuine authorize
  // URL so configuration can be verified against a real IdP.
  .get("/public/sso/start", async (c) => {
    const org = await resolveOrgFromRequest(c);
    if (!org) throw new HttpError(404, "Unknown workspace.");
    const [conn] = await withAdmin((tx) =>
      tx
        .select({
          issuer: tenantSsoConnection.issuer,
          clientId: tenantSsoConnection.clientId,
          enabled: tenantSsoConnection.enabled,
        })
        .from(tenantSsoConnection)
        .where(eq(tenantSsoConnection.tenantId, org.id))
        .limit(1),
    );
    if (!conn?.enabled) throw new HttpError(404, "SSO is not enabled for this workspace.");
    const host = c.req.header("x-tenant-host") ?? c.req.header("host") ?? "";
    const scheme = process.env.NODE_ENV === "production" ? "https" : "http";
    const redirectUri = `${scheme}://${host}/login/sso/callback`;
    const authorizeUrl = new URL(`${conn.issuer.replace(/\/$/, "")}/authorize`);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", conn.clientId);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("scope", "openid email profile");
    authorizeUrl.searchParams.set("state", crypto.randomUUID());
    return c.json({ authorizationUrl: authorizeUrl.toString(), stub: true });
  })
  // Public: which sign-in methods does the platform currently offer? Pre-auth
  // hint the sign-in pages use to render (or hide) the password form and the
  // social buttons. Returns ONLY what is usable right now — a disabled or
  // unconfigured provider is simply absent, so this leaks no platform config.
  .get("/public/auth-providers", async (c) => {
    const resolved = await resolveAuthProviders();
    return c.json({
      email: resolved.email.available,
      social: AUTH_PROVIDER_IDS.filter(
        (id) => AUTH_PROVIDERS[id].kind === "social" && resolved[id].available,
      ).map((id) => ({ id, label: AUTH_PROVIDERS[id].label })),
    });
  })
  // Accept a staff invitation. Requires a Better Auth session but NOT tenant
  // membership (the invitee isn't a member yet), so it lives outside /rpc's
  // tenantMiddleware. Tenant is resolved from the host; the token is validated
  // against that tenant + the session email in acceptInvite().
  .post(
    "/api/accept-invite",
    zValidator("json", acceptInviteSchema),
    async (c) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (!session?.user) {
        throw new HttpError(401, "Sign in to accept this invitation.");
      }
      const org = await resolveOrgFromRequest(c);
      if (!org) throw new HttpError(404, "Unknown workspace.");
      const { token } = c.req.valid("json");
      const result = await acceptInvite({
        userId: session.user.id,
        userEmail: session.user.email,
        orgId: org.id,
        token,
      });
      if (!result.ok) throw new HttpError(result.status, result.message);
      await recordAudit({
        tenantId: org.id,
        actorType: "staff",
        actorId: session.user.id,
        actorLabel: session.user.email,
        action: "invite.accepted",
        targetType: "invitation",
        targetLabel: session.user.email,
        metadata: { role: result.role, alreadyMember: result.alreadyMember },
        ip: clientIp(c),
      });
      await emitTenantEvent(org.id, "invite.accepted", {
        email: session.user.email,
        role: result.role,
      });
      // Notify whoever sent the invite (best-effort — never block acceptance
      // on this write; a null inviterId, e.g. a very old row, is a no-op).
      if (result.inviterId) {
        await withTenant(org.id, (tx) =>
          tx.insert(tenantNotification).values({
            id: createId(),
            tenantId: org.id,
            recipientUserId: result.inviterId!,
            type: "invite_accepted",
            title: `${session.user.email} accepted your invite`,
            body: null,
            href: "/dashboard/settings/members",
            actorUserId: session.user.id,
            actorName: session.user.name || session.user.email,
          }),
        ).catch((e) => {
          getLogger(c).warn({ err: e, msg: "Failed to record invite_accepted notification" });
        });
      }
      return c.json({ ok: true, role: result.role, tenantSlug: org.slug });
    },
  )
  // Internal job: re-verify all custom domains and deactivate any whose DNS
  // record has disappeared (takeover guard). Not tenant-scoped — protected by a
  // shared secret so only the scheduler can trigger it. Wire to cron later.
  .post("/internal/domains/recheck", async (c) => {
    const secret = process.env.INTERNAL_JOB_TOKEN;
    const provided = c.req.header("x-internal-token");
    if (!secret || provided !== secret) {
      throw new HttpError(401, "Unauthorized.");
    }
    const result = await recheckDomains();
    return c.json(result);
  })
  // Billing webhook (public, raw body, signature/token-verified). Mounted
  // outside /rpc so no tenant/body middleware consumes the raw payload the HMAC
  // is computed over. Provider-agnostic: the active provider (Stripe or Xendit)
  // supplies both the verification scheme and the payload parser. Idempotent by
  // event id; the tenant is resolved from the event's metadata/external id,
  // never from a session. Respond 2xx fast.
  .post("/billing/webhook", async (c) => {
    const driver = getBillingProviderId();
    const provider = getBillingWebhookProvider(driver);
    const secret =
      driver === "paymongo"
        ? process.env.PAYMONGO_WEBHOOK_SECRET
        : driver === "xendit"
          ? process.env.XENDIT_WEBHOOK_TOKEN
          : process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new HttpError(400, "Billing webhook is not configured.");
    const payload = await c.req.text();
    // Stripe signs via the `stripe-signature` header; Xendit sends a shared
    // `x-callback-token`. Pass whichever the active provider expects.
    const header =
      driver === "paymongo"
        ? c.req.header("paymongo-signature")
        : driver === "xendit"
          ? c.req.header("x-callback-token")
          : c.req.header("stripe-signature");
    if (!provider.verifyWebhook({ payload, header, secret })) {
      throw new HttpError(400, "Invalid webhook signature.");
    }
    let event: {
      id?: string;
      type?: string;
      status?: string;
      data?: {
        id?: string;
        attributes?: { type?: string; [key: string]: unknown };
        object?: Record<string, unknown>;
      };
    };
    try {
      event = JSON.parse(payload);
    } catch {
      throw new HttpError(400, "Invalid webhook payload.");
    }
    // Idempotency key + audit label. Stripe carries `id`/`type`; a Xendit invoice
    // callback carries the invoice `id` + `status`, so derive an equivalent pair.
    const eventId =
      driver === "paymongo"
        ? typeof event.data?.id === "string"
          ? event.data.id
          : null
        : typeof event.id === "string"
          ? driver === "xendit"
            ? `${event.id}:${String(event.status ?? "")}`
            : event.id
          : null;
    const eventType =
      driver === "paymongo"
        ? typeof event.data?.attributes?.type === "string"
          ? event.data.attributes.type
          : ""
        : driver === "xendit"
          ? `invoice.${String(event.status ?? "").toLowerCase()}`
          : typeof event.type === "string"
            ? event.type
            : "";
    if (!eventId) throw new HttpError(400, "Missing event id.");

    // Two DISJOINT parse entrypoints, both run so neither is swallowed by the
    // other's null: `parseEvent` maps subscription events
    // (checkout.session.completed / customer.subscription.*), and
    // `parseTransactionEvent` maps charge/refund/invoice events into the
    // `payment_transaction` mirror. For Stripe the two event-type sets are
    // disjoint (exactly one is non-null); for a Xendit PAID callback BOTH fire
    // (it both activates the subscription and records the payment), each
    // idempotent on its own key. The old `if (!parsed) return ignored` early
    // return discarded charge/invoice/refund events entirely — restructured so
    // they reach `recordTransactionEvent`.
    const parsed = provider.parseEvent(payload);
    const parsedTxn = provider.parseTransactionEvent(payload);

    if (parsedTxn) {
      // Best-effort mirror; idempotent by the (provider, object id) unique
      // index. An unresolvable tenant is skipped-and-logged inside, never
      // thrown, so a stray charge can't 500 the webhook.
      await recordTransactionEvent(parsedTxn);
    }

    if (!parsed) {
      return c.json({ received: true, ignored: !parsedTxn });
    }

    const result = await applyWebhookEvent(eventId, eventType, parsed);
    // Checked BEFORE the non-suppressed branch (Condition 2) — a suppressed
    // event never reused billing.subscription_updated/_created/_canceled,
    // since no such change actually happened to the row.
    if (result.ok && !result.deduped && result.suppressed) {
      await recordAudit({
        tenantId: result.tenantId,
        actorType: "system",
        action: "billing.subscription_webhook_suppressed",
        targetType: "subscription",
        targetId: result.tenantId,
        metadata: {
          eventType,
          attemptedPlan: parsed.plan,
          attemptedStatus: parsed.status,
        },
      });
    } else if (result.ok && !result.deduped && !result.suppressed) {
      const action = result.created
        ? "billing.subscription_created"
        : result.status === "canceled"
          ? "billing.subscription_canceled"
          : "billing.subscription_updated";
      await recordAudit({
        tenantId: result.tenantId,
        actorType: "system",
        action,
        targetType: "subscription",
        targetId: result.tenantId,
        metadata: { eventType, status: result.status, plan: parsed.plan },
      });
    }
    return c.json({ received: true });
  })
  // Device-facing pairing/auth/heartbeat (Chrono `devices` module, Phase 3).
  // No Better Auth session, no tenant membership row — the device itself
  // authenticates via its own module-local bearer middleware
  // (requireDeviceBearerAuth()), independently of tenantMiddleware(). Mounted
  // outside /rpc and outside apiV1, alongside /billing/webhook and the
  // /public/* family — see .ai/plans/chrono/active/devices/README.md.
  .route("/api/v1/device", deviceAuthRoutes())
  // Platform Maintenance / global read-only enforcement (System Settings, spec
  // #14) for TENANT traffic only. The `/rpc-admin/*` surface is a separate
  // mount and never passes through here, so an admin can always turn the flags
  // back off. Platform-admin actors are additionally exempt on /rpc so they can
  // never lock themselves out. Fail-open on a settings DB error (resolver
  // returns registry defaults = off); the break-glass env var
  // (`PLATFORM_SETTINGS_ENFORCEMENT_DISABLED`) bypasses the resolver entirely.
  //
  // "Platform shutdown" is deliberately NOT a real process kill — it is modeled
  // as maintenance + read-only, an in-app reversible state, per the plan.
  .use("/rpc/*", maintenanceReadOnlyGate)
  // Same gate on the public versioned API — a maintenance window or
  // read-only lockdown must cover third-party integrations too, not just
  // the internal /rpc client.
  .use("/api/v1/*", maintenanceReadOnlyGate)
  // Staff tenant-scoped RPC.
  .route("/rpc", rpc)
  // Public versioned API (see .ai/plans/agora/archive/generic-multitenant-extensibility)
  .route("/api/v1", apiV1)
  // Platform admin (Agora staff, cross-tenant, no tenant context). Gated
  // per-route by requirePlatformPermissionForRequest, not tenantMiddleware.
  .route("/rpc-admin", platformAdminRoutes({ lifecycle }))
  // Cross-tenant metrics — lives in `agora/platform-admin`; the app injects
  // `projectCountsByTenant` so the foundation reads the app-owned `project`
  // table without importing app schema. Same gate (organization:read).
  .route("/rpc-admin/metrics", appMetricsRoutes({ projectCountsByTenant }))
  // Cross-tenant time-series reporting (tenant growth, plan changes, churn) —
  // reads only the foundation `tenantSubscriptionEvent` table, so it lives in
  // `agora/platform-admin` and is re-exported from there. Same gate
  // (organization:read).
  .route("/rpc-admin/reports", appReportsRoutes())
  // Cross-tenant usage & limits — lives in `agora/platform-admin`; same injected
  // `projectCountsByTenant` provider as metrics. Gated per-route on the `usage`
  // platform permission (`read`; `manageQuota` on the grant routes).
  .route("/rpc-admin/usage", appUsageRoutes({ projectCountsByTenant }))
  // Admin org-detail upload target (global-upload-drag-drop-paste Phase 3):
  // an admin already viewing one org can drag/paste a file into it, which
  // lands in that org's OWN `storedFile`/storage — same mechanics as the
  // tenant `/rpc/files/sign` route, injected here since `storedFile` is
  // app-owned and the foundation must not import app schema.
  .route(
    "/rpc-admin/organizations",
    appFilesRoutes({
      // Platform admins aren't tenant members, so there's no `uploadedBy`
      // member userId for these rows — null, same as any other
      // system/automation-originated write.
      signUpload: (tenantId, input) => signFileForTenant(tenantId, null, input),
      confirmUpload: async (tenantId, fileId, input) => {
        const { publicUrl } = await confirmFileForTenant(tenantId, fileId, input);
        return { publicUrl };
      },
    }),
  );

// Best-effort `result: "failure"` audit row for a DENIED/FAILED mutating
// `/rpc-admin/*` request. FULLY non-throwing and fire-and-forget — it must
// never mask or delay the error response the mapper is emitting (a failed
// audit write must never turn a 403 into a 500). Skips GET denials (a denied
// read is noise) and non-admin surfaces. `actorRole`/`actorId` are resolved
// best-effort and are often null on a permission-denied request.
const MUTATING_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);
async function auditPlatformAdminFailure(
  c: Parameters<Parameters<typeof app.onError>[0]>[1],
  status: number,
  message: string,
): Promise<void> {
  try {
    if (!MUTATING_METHODS.has(c.req.method)) return;
    if (!c.req.path.startsWith("/rpc-admin")) return;
    let actorId: string | null = null;
    let actorLabel: string | null = null;
    let actorRole: string | null = null;
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session?.user) {
        actorId = session.user.id;
        actorLabel = session.user.email;
        actorRole = await readPlatformRoleByUserId(session.user.id);
      }
    } catch {
      // Session/role resolution is best-effort; a failure just leaves the
      // actor fields null — the failure row is still recorded.
    }
    await recordPlatformAuditFailure({
      actorId,
      actorLabel,
      actorRole,
      action: "platform_admin.request_failed",
      metadata: { method: c.req.method, path: c.req.path, status, message },
      ip: clientIp(c),
      userAgent: userAgent(c),
    });
  } catch {
    // Non-throwing by contract — never let auditing affect the error response.
  }
}

app.onError((err, c) => {
  if (err instanceof HttpError) {
    void auditPlatformAdminFailure(c, err.status, err.message);
    return c.json({ error: err.message }, err.status);
  }
  if (err instanceof ForbiddenError) {
    void auditPlatformAdminFailure(c, 403, err.message);
    return c.json({ error: err.message }, 403);
  }
  if (err instanceof PlanRequiredError) {
    return c.json({ error: err.message, feature: err.feature }, 402);
  }
  if (err instanceof PortalNotSupportedError) {
    return c.json({ error: err.message }, err.status);
  }
  const tenant = (c.var as unknown as Record<string, unknown>).tenant as
    | { tenantId?: string; userId?: string }
    | undefined;
  getLogger(c).error({
    err: err instanceof Error ? { message: err.message, stack: err.stack } : err,
    msg: "Unhandled error",
  });
  captureError(err, {
    requestId: c.get("requestId"),
    tenantId: tenant?.tenantId,
    userId: tenant?.userId,
    method: c.req.method,
    path: c.req.path,
  });
  return c.json({ error: "Internal Server Error" }, 500);
});

export type AppType = typeof app;
export { rpc };
export type { RpcType } from "./routes/rpc";
