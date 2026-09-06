import { adminDb, schema as base, eq, and, isNull, isNotNull } from "agora/db";
import { getEmailSender, renderBrandedEmail, escapeHtml, logger } from "agora/server";
import { chronoBusinessLead } from "./schema";
import { resolveCallerNormalizedBusinessName } from "./routes";

/** Build a tenant-host URL, mirroring `agora/auth`'s own `tenantHostUrl` helper. */
function tenantHostUrl(slug: string, path: string): string {
  const appDomain = process.env.APP_DOMAIN ?? "localtest.me:3000";
  const scheme = process.env.NODE_ENV === "production" ? "https" : "http";
  return `${scheme}://${slug}.${appDomain}${path}`;
}

/**
 * Post-lead "we'll notify you" follow-up (growth-loop-hardening Phase 6).
 *
 * Called from `apps/chrono-api/src/routes/rpc.ts`'s `landingRoutes({ onPublish })`
 * hook, after a tenant's publish write has already committed — this function
 * is itself best-effort (mirrors `notifyBusinessLeadSubmitted`'s stance in
 * `routes.ts`): a failure here must never surface to the publishing admin,
 * whose request has already succeeded by the time this runs.
 *
 * Matching reuses the exact same normalized-name predicate
 * `GET /rpc/growth/demand`/`/leads` already use, so a lead is notified if and
 * only if it would also show up in this tenant's own lead-detail console.
 * Only leads with a non-null `requesterCustomerId` (a signed-in player) and a
 * null `notifiedAt` are candidates — an anonymous lead can never be emailed,
 * and a lead already notified on a prior publish is never emailed twice.
 */
export async function notifyMatchedLeadsOnPublish(tenantId: string): Promise<void> {
  try {
    const normalized = await resolveCallerNormalizedBusinessName(tenantId);

    const candidates = await adminDb
      .select({
        id: chronoBusinessLead.id,
        requesterCustomerId: chronoBusinessLead.requesterCustomerId,
      })
      .from(chronoBusinessLead)
      .where(
        and(
          eq(chronoBusinessLead.businessNameNormalized, normalized),
          isNotNull(chronoBusinessLead.requesterCustomerId),
          isNull(chronoBusinessLead.notifiedAt),
        ),
      );

    if (candidates.length === 0) return;

    const [org] = await adminDb
      .select({ name: base.organization.name, slug: base.organization.slug })
      .from(base.organization)
      .where(eq(base.organization.id, tenantId))
      .limit(1);
    if (!org) return;

    for (const lead of candidates) {
      // Narrowed by the `isNotNull` predicate above, but the column type
      // itself is still nullable.
      if (!lead.requesterCustomerId) continue;
      await notifyOneLead({
        leadId: lead.id,
        customerId: lead.requesterCustomerId,
        businessName: org.name,
        tenantSlug: org.slug,
      });
    }
  } catch (err) {
    logger.warn({ err, msg: "growth-loop: onPublish notification pass failed" });
  }
}

async function notifyOneLead(input: {
  leadId: string;
  customerId: string;
  businessName: string;
  tenantSlug: string;
}): Promise<void> {
  const { leadId, customerId, businessName, tenantSlug } = input;
  try {
    const [customerRow] = await adminDb
      .select({ email: base.customer.email, name: base.customer.name })
      .from(base.customer)
      .where(eq(base.customer.id, customerId))
      .limit(1);
    if (!customerRow) return;

    // Platform-authored email, no tenant branding — same stance
    // `notifyBusinessLeadSubmitted` (routes.ts) takes for IZUR's own inbox.
    const branding = {
      displayName: null,
      emailFromName: null,
      emailReplyTo: null,
      emailLogoUrl: "https://chrono.izur.com.ph/brand/chrono-owl.png",
      logoDarkUrl: null,
      primaryColor: null,
      supportEmail: null,
    };

    const tenantUrl = tenantHostUrl(tenantSlug, "/");
    const bodyHtml = [
      `<p>Good news — <strong>${escapeHtml(businessName)}</strong>, the business you`,
      ` asked about on Chrono, has just joined and published their page.</p>`,
      `<p><a href="${escapeHtml(tenantUrl)}">Visit their page</a></p>`,
    ].join("");

    const emailParts = renderBrandedEmail(branding, {
      subject: `${businessName} just joined Chrono`,
      bodyHtml,
    });

    const sender = getEmailSender();
    await sender.send({
      to: customerRow.email,
      from: emailParts.from,
      subject: emailParts.subject,
      html: emailParts.html,
    });

    // Marked only after a successful send — a send failure leaves notifiedAt
    // null so a LATER publish (or a retry) can still try again, rather than
    // silently losing the notification forever.
    await adminDb
      .update(chronoBusinessLead)
      .set({ notifiedAt: new Date() })
      .where(eq(chronoBusinessLead.id, leadId));
  } catch (err) {
    logger.warn({ err, leadId, msg: "growth-loop: failed to notify one matched lead" });
  }
}
