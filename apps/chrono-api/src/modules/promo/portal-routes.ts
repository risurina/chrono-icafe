import { Hono } from "hono";
import { withTenant, eq, and, or, isNull, gte, lte, count } from "agora/db";
import { type MemberVars, memberMiddleware } from "agora/member-auth";
import { chronoPromo, chronoPromoRedemption } from "./schema";
import { chronoBranch } from "../branch/schema";
import type { PortalPromoDto } from "./contracts";

/**
 * Customer-facing active-promotions read surface — gated by the foundation's
 * `memberMiddleware()`, NOT `tenantMiddleware()`/`requirePermission`.
 * Mounted directly on the Hono app at `/portal/promos`.
 *
 * Only `status: "active"`, in-window, redemption-cap-not-exhausted promos are
 * returned, and only safe fields — never counts or ids beyond the promo's
 * own. There is deliberately no redemption route here: promos apply at
 * POS/counter, not to member-initiated credit-pack purchases (Phase C).
 */
export function promoPortalRoutes() {
  return new Hono<{ Variables: MemberVars }>()
    .use("*", memberMiddleware())
    .get("/", async (c) => {
      const { tenantId } = c.var.member;
      const now = new Date();

      const rows = await withTenant(tenantId, async (tx) => {
        const candidates = await tx
          .select({
            id: chronoPromo.id,
            name: chronoPromo.name,
            code: chronoPromo.code,
            description: chronoPromo.description,
            discountType: chronoPromo.discountType,
            discountValue: chronoPromo.discountValue,
            minSpend: chronoPromo.minSpend,
            startsAt: chronoPromo.startsAt,
            endsAt: chronoPromo.endsAt,
            maxRedemptions: chronoPromo.maxRedemptions,
            branchName: chronoBranch.name,
          })
          .from(chronoPromo)
          .leftJoin(chronoBranch, eq(chronoPromo.branchId, chronoBranch.id))
          .where(
            and(
              eq(chronoPromo.status, "active"),
              or(isNull(chronoPromo.startsAt), lte(chronoPromo.startsAt, now)),
              gte(chronoPromo.endsAt, now),
            ),
          );

        const withRedemptionCounts = await Promise.all(
          candidates.map(async (promo) => {
            if (promo.maxRedemptions == null) return { promo, exhausted: false };
            const [row] = await tx
              .select({ value: count() })
              .from(chronoPromoRedemption)
              .where(eq(chronoPromoRedemption.promoId, promo.id));
            return { promo, exhausted: (row?.value ?? 0) >= promo.maxRedemptions };
          }),
        );

        return withRedemptionCounts
          .filter((r) => !r.exhausted)
          .map(({ promo }): PortalPromoDto => ({
            id: promo.id,
            name: promo.name,
            code: promo.code,
            description: promo.description,
            discountType: promo.discountType as PortalPromoDto["discountType"],
            discountValue: promo.discountValue,
            minSpend: promo.minSpend,
            startsAt: promo.startsAt ? promo.startsAt.toISOString() : null,
            endsAt: promo.endsAt.toISOString(),
            branchName: promo.branchName,
          }));
      });

      return c.json({ items: rows });
    });
}
