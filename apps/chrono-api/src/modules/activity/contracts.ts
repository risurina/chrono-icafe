import { z } from "zod";
import { listQuerySchema } from "agora";

/**
 * member-portal-v2 Phase 8 — unified activity feed. `GET /portal/activity`
 * aggregates wallet + credit + session + reservation events into one
 * normalized, paginated, sorted timeline, replacing the three-tab history
 * view. This module owns no table of its own — it is a read-only
 * cross-module aggregation over four existing tenant-scoped tables (wallet/
 * credit/session/reservation), each already RLS-forced and already listed in
 * `APP_TENANT_TABLES` by its own module.
 */
export const activityEventTypeSchema = z.enum(["wallet", "credit", "session", "reservation"]);
export type ActivityEventType = z.infer<typeof activityEventTypeSchema>;

/**
 * Offset pagination (`.ai/rules/pagination.md`), matching every sibling
 * portal list route (wallet history, credit ledger, sessions) rather than a
 * cursor — kept for consistency with those three, and because the feed's
 * only sort key is a single `occurredAt desc` timeline with no natural
 * cursor tiebreaker gap across four heterogeneous source tables. `type`
 * narrows to a single source branch (skips the UNION ALL entirely — see
 * routes.ts) rather than filtering the merged result, which is both simpler
 * and cheaper.
 */
export const activityListQuerySchema = listQuerySchema(["occurredAt"]).extend({
  type: activityEventTypeSchema.optional(),
});
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;

/**
 * Normalized shape every source event is projected into at the SQL layer.
 * `amount` is money (a signed decimal string) only for wallet/session/
 * reservation events — credit events move minutes, not money, so their
 * quantity is folded into `description` instead of forced into this field.
 * `status` carries each source's own free-text status/type column where one
 * exists (credit ledger entry type, session status, reservation status) and
 * is null for wallet (no status concept).
 */
export const activityEventDtoSchema = z.object({
  id: z.string(),
  type: activityEventTypeSchema,
  occurredAt: z.string(),
  title: z.string(),
  description: z.string(),
  amount: z.string().nullable(),
  status: z.string().nullable(),
});
export type ActivityEventDto = z.infer<typeof activityEventDtoSchema>;
