import { authClient } from "@/lib/auth-client";
import { adminApi } from "@/lib/admin-client";
import {
  isTenantHost,
  isTrustedHost,
  safeNextPath,
} from "agora/client";

// Pure host/redirect/auth-error helpers are foundation browser logic and live in
// `agora/client`; re-exported here so existing app call sites keep importing from
// `@/lib/post-auth`.
export {
  isTenantHost,
  isTrustedHost,
  safeNextPath,
  socialCallbackUrl,
  socialErrorUrl,
  describeAuthError,
} from "agora/client";

const APP_DOMAIN = process.env.NEXT_PUBLIC_APP_DOMAIN ?? "localtest.me:3000";

/**
 * Where a freshly-authenticated user should land.
 *
 * Shared by the password form, the social callback, and anything else that
 * completes a sign-in, so all of them agree. Previously the apex path sent a
 * user with no organizations to `/dashboard` — a host with no tenant, i.e. a
 * dead end. A user with nowhere to go goes to workspace creation instead.
 *
 * Stays app-side because it composes the app's typed `adminApi` client and the
 * Better Auth `authClient`; the pure host helpers it uses are from `agora/client`.
 *
 * `nextHost` exists for the social round trip: OAuth returns to a single fixed
 * apex callback, so a `?next=` that belonged to a tenant subdomain has lost the
 * host it was relative to by the time we get back. The caller carries the
 * origin across and we re-attach it here, after validating it.
 */
export async function resolveLandingUrl(nextHost?: string | null): Promise<string> {
  const host = window.location.host;
  const params = new URLSearchParams(window.location.search);
  const next = safeNextPath(params.get("next"));

  // An explicit deep link (e.g. an accept-invite link) wins when we can place
  // it on a host we trust.
  if (next) {
    if (isTenantHost(host)) return next;
    if (nextHost && isTrustedHost(nextHost) && isTenantHost(nextHost)) {
      return `${window.location.protocol}//${nextHost}${next}`;
    }
  }
  if (isTenantHost(host)) return "/dashboard";

  // A platform admin holds no tenant membership by convention (see
  // .ai/rules/rbac.md), so it must be checked before the org lookup below —
  // otherwise it always falls through to workspace creation.
  const me = await adminApi["rpc-admin"].me.$get().then((r) => r.json());
  if (me.platformRole) return "/admin";

  const orgs = await authClient.organization.list();
  const first = orgs.data?.[0];
  if (!first) return "/new-workspace?welcome=1";
  return `${window.location.protocol}//${first.slug}.${APP_DOMAIN}/dashboard`;
}
