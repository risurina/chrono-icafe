import { Hono } from "hono";
import { withAdmin } from "agora/db";
import { HttpError, resolveOrgFromRequest, createRateLimiter, clientIp } from "agora/server";
import { createId } from "agora";
import { chronoInquiry, chronoInquiryMessage } from "./schema";
import { submitPublicInquirySchema } from "./contracts";
import { notifyInquiryManagers } from "./notify";

// Per-IP throttle on the anonymous public form — Divergence 3 in the plan:
// oikos's public inquiry endpoints have no secondary rate limiter behind
// their (also-unimplemented-here) CAPTCHA. 10/hour/IP is generous for a
// genuine visitor asking one question, tight for a spam script — same order
// of magnitude as `staffSignUpLimiter` (10/hour) in apps/chrono-api/src/app.ts.
const publicInquiryLimiter = createRateLimiter(10, 60 * 60 * 1000, "inquiry-public");

/**
 * Chrono's public, pre-tenant-context "Contact Us" surface — mounted
 * directly on `app` (`/public/inquiries`), outside `/rpc` and outside
 * `tenantMiddleware()`. See `apps/chrono-api/AGENTS.md`'s "Unauthenticated
 * routes" convention and `qr`'s `public-routes.ts`, which this mirrors for
 * host-resolution + rate-limiting.
 */
export function inquiryPublicRoutes() {
  return new Hono().post("/", async (c) => {
    const ip = clientIp(c);
    const retryAfter = await publicInquiryLimiter.blockedFor(ip);
    if (retryAfter !== null) {
      return c.json({ error: "Too many attempts. Try again later." }, 429, {
        "Retry-After": String(retryAfter),
      });
    }

    const org = await resolveOrgFromRequest(c);
    if (!org) throw new HttpError(404, "Unknown workspace.");
    const status = org.status;
    if (
      status === "suspended" ||
      status === "cancelled" ||
      status === "archived" ||
      status === "deleting"
    ) {
      throw new HttpError(404, "Unknown workspace.");
    }

    const parsed = submitPublicInquirySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(400, "Invalid submission.");
    }
    const { submitterName, submitterEmail, submitterPhone, category, subject, message } = parsed.data;

    await publicInquiryLimiter.record(ip);

    const created = await withAdmin((tx) =>
      tx
        .insert(chronoInquiry)
        .values({
          id: createId(),
          tenantId: org.id,
          tenantMemberId: null,
          submitterName,
          submitterEmail,
          submitterPhone: submitterPhone ?? null,
          category,
          subject,
          status: "new",
        })
        .returning(),
    );
    const inquiry = created[0];
    if (inquiry) {
      await withAdmin((tx) =>
        tx.insert(chronoInquiryMessage).values({
          id: createId(),
          tenantId: org.id,
          inquiryId: inquiry.id,
          authorType: "customer",
          authorMemberId: null,
          body: message,
        }),
      );
      await notifyInquiryManagers(org.id, inquiry.id, inquiry.subject);
    }

    // No thread access afterward for an anonymous submitter (Open Question
    // 6's default) — only a confirmation, never the row itself.
    return c.json({ submitted: true }, 201);
  });
}
