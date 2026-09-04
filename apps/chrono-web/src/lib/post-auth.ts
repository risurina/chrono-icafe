import { authClient } from "@/lib/auth-client";
import { adminApi } from "@/lib/admin-client";
import { api } from "@/lib/rpc";
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
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

type OnboardingChecklistSummary = {
  completedCount: number;
  allDone: boolean;
  dismissed: boolean;
};

/**
 * Derivable "brand-new, untouched tenant" condition for the onboarding-wizard
 * redirect (onboarding-wizard plan, Phase 3, "Open Question 1 — resolved").
 * Deliberately NOT a stored "first login" flag — this plan forbids any new
 * persisted cursor, so the condition is read straight off the same onboarding
 * state the checklist card renders: zero items done, not all done (redundant
 * once zero are done, kept for clarity), and not dismissed. True exactly once
 * in practice, and self-corrects the moment the owner does or dismisses
 * anything — no owner can ever get stuck in the wizard.
 */
function checklistIsUntouched(state: OnboardingChecklistSummary): boolean {
  return !state.dismissed && !state.allDone && state.completedCount === 0;
}

/**
 * Fetch the onboarding checklist for an explicit tenant slug — used for the
 * brand-new-business path below, where we are still on the apex host and the
 * typed `api` client (which derives its tenant header from the CURRENT host)
 * cannot be pointed at the just-created tenant.
 */
async function fetchChecklistForSlug(slug: string): Promise<OnboardingChecklistSummary | null> {
  try {
    const res = await fetch(`${API_URL}/onboarding/checklist`, {
      credentials: "include",
      headers: { "x-tenant-slug": slug },
    });
    if (!res.ok) return null;
    return (await res.json()) as OnboardingChecklistSummary;
  } catch {
    return null;
  }
}

/**
 * Where a freshly-authenticated user should land.
 *
 * Shared by the password form, the social callback, and anything else that
 * completes a sign-in, so all of them agree. Previously the apex path sent a
 * user with no organizations to `/dashboard` — a host with no tenant, i.e. a
 * dead end. A user with nowhere to go goes to business creation instead.
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
  if (isTenantHost(host)) {
    const res = await api.rpc.onboarding.checklist.$get();
    if (res.ok && checklistIsUntouched(await res.json())) {
      return "/admin/setup";
    }
    return "/admin";
  }

  // A platform admin holds no tenant membership by convention (see
  // .ai/rules/rbac.md), so it must be checked before the org lookup below —
  // otherwise it always falls through to business creation.
  const me = await adminApi["rpc-admin"].me.$get().then((r) => r.json());
  if (me.platformRole) return "/admin";

  const orgs = await authClient.organization.list();
  const first = orgs.data?.[0];
  if (!first) return "/new-business?welcome=1";
  const checklist = await fetchChecklistForSlug(first.slug);
  const landing = checklist && checklistIsUntouched(checklist) ? "/admin/setup" : "/admin";
  return `${window.location.protocol}//${first.slug}.${APP_DOMAIN}${landing}`;
}
