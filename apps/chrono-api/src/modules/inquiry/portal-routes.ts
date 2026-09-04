import { Hono } from "hono";
import { withTenant, eq, and, asc, desc, count } from "agora/db";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { zValidator, HttpError } from "agora/server";
import { createId, buildPaginationMeta } from "agora";
import { chronoInquiry, chronoInquiryMessage } from "./schema";
import { submitPortalInquirySchema, replyToInquirySchema, inquiryListQuerySchema } from "./contracts";
import { notifyInquiryManagers } from "./notify";

/**
 * Customer-facing inquiry self-service surface — gated by the foundation's
 * `memberMiddleware()` (a `tenantMember`/portal session), NOT
 * `tenantMiddleware()`/`requirePermission`. Mounted directly on the Hono app
 * at `/portal/inquiries`, mirroring `/portal/wallet` / `/portal/members`.
 *
 * Every read/write below is scoped to BOTH tenant RLS (via `withTenant`) AND
 * the calling member's own `tenantMemberId` — RLS alone only proves tenant
 * isolation, not that member A can't see member B's inquiry within the same
 * tenant (the module plan's "Failure cases" section).
 */
export function inquiryPortalRoutes() {
  return new Hono<{ Variables: MemberVars }>()
    .use("*", memberMiddleware())

    .get("/", zValidator("query", inquiryListQuerySchema), async (c) => {
      const { tenantId, memberId } = c.var.member;
      const { page, pageSize, sort, order, status, category } = c.req.valid("query");

      const conds = [eq(chronoInquiry.tenantMemberId, memberId)];
      if (status) conds.push(eq(chronoInquiry.status, status));
      if (category) conds.push(eq(chronoInquiry.category, category));
      const where = and(...conds);

      const sortCol = sort === "updatedAt" ? chronoInquiry.updatedAt : chronoInquiry.createdAt;
      const sortFn = order === "asc" ? asc : desc;

      const { rows, totalItems } = await withTenant(tenantId, async (tx) => {
        const [total] = await tx.select({ value: count() }).from(chronoInquiry).where(where);
        const rows = await tx
          .select()
          .from(chronoInquiry)
          .where(where)
          .orderBy(sortFn(sortCol))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
        return { rows, totalItems: total?.value ?? 0 };
      });

      return c.json({
        items: rows,
        meta: buildPaginationMeta(page, pageSize, totalItems, sort, order),
      });
    })

    .get("/:id", async (c) => {
      const { tenantId, memberId } = c.var.member;
      const id = c.req.param("id");

      const { inquiry, messages } = await withTenant(tenantId, async (tx) => {
        const [inquiry] = await tx
          .select()
          .from(chronoInquiry)
          .where(
            and(
              eq(chronoInquiry.id, id),
              eq(chronoInquiry.tenantId, tenantId),
              eq(chronoInquiry.tenantMemberId, memberId),
            ),
          )
          .limit(1);
        if (!inquiry) throw new HttpError(404, "Inquiry not found.");
        const messages = await tx
          .select()
          .from(chronoInquiryMessage)
          .where(and(eq(chronoInquiryMessage.inquiryId, id), eq(chronoInquiryMessage.tenantId, tenantId)))
          .orderBy(asc(chronoInquiryMessage.createdAt));
        return { inquiry, messages };
      });

      return c.json({ inquiry, messages });
    })

    .post("/", zValidator("json", submitPortalInquirySchema), async (c) => {
      const { tenantId, memberId, email, name } = c.var.member;
      const { category, subject, message } = c.req.valid("json");

      const created = await withTenant(tenantId, async (tx) => {
        const [inquiry] = await tx
          .insert(chronoInquiry)
          .values({
            id: createId(),
            tenantId,
            tenantMemberId: memberId,
            submitterName: name,
            submitterEmail: email,
            category,
            subject,
            status: "new",
          })
          .returning();
        await tx.insert(chronoInquiryMessage).values({
          id: createId(),
          tenantId,
          inquiryId: inquiry!.id,
          authorType: "customer",
          authorMemberId: memberId,
          body: message,
        });
        return inquiry;
      });

      if (created) {
        await notifyInquiryManagers(tenantId, created.id, created.subject);
      }
      return c.json({ inquiry: created }, 201);
    })

    .post("/:id/reply", zValidator("json", replyToInquirySchema), async (c) => {
      const { tenantId, memberId } = c.var.member;
      const id = c.req.param("id");
      const { body } = c.req.valid("json");

      const { inquiry, message } = await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select()
          .from(chronoInquiry)
          .where(
            and(
              eq(chronoInquiry.id, id),
              eq(chronoInquiry.tenantId, tenantId),
              eq(chronoInquiry.tenantMemberId, memberId),
            ),
          )
          .limit(1);
        if (!existing) throw new HttpError(404, "Inquiry not found.");

        const [message] = await tx
          .insert(chronoInquiryMessage)
          .values({
            id: createId(),
            tenantId,
            inquiryId: id,
            authorType: "customer",
            authorMemberId: memberId,
            body,
          })
          .returning();

        // A customer reply on a resolved/closed inquiry auto-reopens it into
        // "in_progress" (Open Question 1's default); any other status is
        // left untouched by a customer message (only a staff reply/assign
        // advances "new"/"assigned").
        const reopening = existing.status === "resolved" || existing.status === "closed";
        const nextStatus = reopening ? "in_progress" : existing.status;
        const [row] = await tx
          .update(chronoInquiry)
          .set({
            status: nextStatus,
            closedAt: reopening ? null : existing.closedAt,
            updatedAt: new Date(),
          })
          .where(and(eq(chronoInquiry.id, id), eq(chronoInquiry.tenantId, tenantId)))
          .returning();
        return { inquiry: row, message };
      });

      return c.json({ inquiry, message }, 201);
    });
}
