import { Hono } from "hono";
import {
  HttpError,
  createRateLimiter,
  clientIp,
  getEmailSender,
  renderBrandedEmail,
  escapeHtml,
} from "agora/server";
import { submitCompanyInquirySchema } from "./contracts";

// Per-IP throttle on the anonymous public form — same 10/hour ceiling as
// `apps/chrono-api/src/modules/inquiry/public-routes.ts`'s `publicInquiryLimiter`.
const companyInquiryPublicLimiter = createRateLimiter(
  10,
  60 * 60 * 1000,
  "company-inquiry-public",
);

/**
 * IZUR's own anonymous, pre-tenant-context lead-capture surface — mounted
 * directly on `app` (`/public/company-inquiries`), outside `/rpc` and outside
 * `tenantMiddleware()`. There is no tenant here: this is about IZUR itself,
 * not a business's tenant. Shared by the apex `/support` (this plan) and
 * `/company/contact` (apex-company-contact) pages via `source`.
 *
 * See `apps/chrono-api/AGENTS.md`'s "Unauthenticated routes" convention and
 * `apps/chrono-api/src/modules/inquiry/public-routes.ts`, which this mirrors
 * for rate-limiting shape.
 */
export function companyInquiryPublicRoutes() {
  return new Hono().post("/", async (c) => {
    const ip = clientIp(c);
    const retryAfter = await companyInquiryPublicLimiter.blockedFor(ip);
    if (retryAfter !== null) {
      return c.json({ error: "Too many attempts. Try again later." }, 429, {
        "Retry-After": String(retryAfter),
      });
    }

    const parsed = submitCompanyInquirySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new HttpError(400, "Invalid submission.");
    }
    const { name, email, businessName, requestType, message, numberOfPcs, numberOfBranches, source } =
      parsed.data;

    const inboxEmail = process.env.SUPPORT_INBOX_EMAIL;
    if (!inboxEmail) {
      // Never silently claim success while dropping the lead — a missing
      // inbox is a real config failure, not a soft no-op. HttpError's status
      // union has no 500, so this is a plain throw — the app's catch-all
      // `onError` handler logs it and returns a generic 500, same as any
      // other unexpected server-side failure.
      throw new Error("SUPPORT_INBOX_EMAIL is not configured.");
    }

    // Platform-authored email carries no tenant branding — this is IZUR's
    // own inbox, not a tenant's. Mirrors the platform announcement-email
    // pattern (`packages/agora/src/core/server/announcements.ts`).
    const branding = {
      displayName: null,
      emailFromName: null,
      emailReplyTo: null,
      emailLogoUrl: null,
      primaryColor: null,
      supportEmail: null,
    };

    const bodyHtml = [
      `<p><strong>Source:</strong> ${escapeHtml(source)}</p>`,
      `<p><strong>Name:</strong> ${escapeHtml(name)}</p>`,
      `<p><strong>Email:</strong> ${escapeHtml(email)}</p>`,
      businessName
        ? `<p><strong>Business name:</strong> ${escapeHtml(businessName)}</p>`
        : "",
      `<p><strong>Request type:</strong> ${escapeHtml(requestType)}</p>`,
      numberOfPcs !== undefined
        ? `<p><strong>Number of PCs:</strong> ${numberOfPcs}</p>`
        : "",
      numberOfBranches !== undefined
        ? `<p><strong>Number of branches:</strong> ${numberOfBranches}</p>`
        : "",
      `<p><strong>Message:</strong><br/>${escapeHtml(message).replace(/\n/g, "<br/>")}</p>`,
    ]
      .filter(Boolean)
      .join("\n");

    const emailParts = renderBrandedEmail(branding, {
      subject: `New ${source} inquiry from ${name}`,
      bodyHtml,
    });

    try {
      const sender = getEmailSender();
      await sender.send({
        to: inboxEmail,
        from: emailParts.from,
        replyTo: email,
        subject: emailParts.subject,
        html: emailParts.html,
      });
    } catch (err) {
      // Validate + rate-limit first, attempt the send, only report success
      // once it actually lands — a lost lead here is permanently gone if the
      // UI reports success anyway (see the plan's Pass 1 failure case). Same
      // "no 500 on HttpError" reasoning as above — plain throw, generic 500.
      throw err instanceof Error ? err : new Error("Failed to send company inquiry email.");
    }

    // Record the hit only after a successful send, mirroring the existing
    // inquiry route's order.
    await companyInquiryPublicLimiter.record(ip);

    // No thread/row exists — only ever a confirmation.
    return c.json({ submitted: true }, 201);
  });
}
