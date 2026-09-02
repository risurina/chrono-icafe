import { Hono } from "hono";
import { withTenant, withAdmin, eq, and } from "agora/db";
import { ne } from "drizzle-orm";
import { requirePermission } from "../../auth/require-permission";
import { type TenantVars, zValidator } from "agora/server";
import { chronoLandingPage } from "./schema";
import { chronoBranch } from "../branch/schema";
import { chronoStation } from "../station/schema";
import { updateLandingPageSchema, type LandingPageContent } from "./contracts";

function toContent(
  row: typeof chronoLandingPage.$inferSelect | undefined,
): LandingPageContent | null {
  if (!row) return null;
  return {
    heroTagline: row.heroTagline,
    aboutBody: row.aboutBody,
    amenitiesBody: row.amenitiesBody,
    contactOverride: row.contactOverride,
    ctaLabel: row.ctaLabel,
    ctaHref: row.ctaHref,
  };
}

/** Staff-facing landing-page settings editor, mounted `/rpc/landing-page`. */
export function landingPageRoutes() {
  return new Hono<{ Variables: TenantVars }>()
    .get("/", async (c) => {
      const { tenantId } = c.var.tenant;
      const [row] = await withTenant(tenantId, (tx) =>
        tx.select().from(chronoLandingPage).where(eq(chronoLandingPage.tenantId, tenantId)).limit(1),
      );
      return c.json({ content: toContent(row) });
    })
    .patch("/", zValidator("json", updateLandingPageSchema), async (c) => {
      const { tenantId, userId } = c.var.tenant;
      requirePermission(c.var.tenant.permissions, { landingPage: ["manage"] });
      const input = c.req.valid("json");

      const [row] = await withTenant(tenantId, async (tx) => {
        const [existing] = await tx
          .select({ id: chronoLandingPage.id })
          .from(chronoLandingPage)
          .where(eq(chronoLandingPage.tenantId, tenantId))
          .limit(1);

        if (existing) {
          return tx
            .update(chronoLandingPage)
            .set({ ...input, updatedAt: new Date(), updatedByUserId: userId })
            .where(eq(chronoLandingPage.tenantId, tenantId))
            .returning();
        }
        return tx
          .insert(chronoLandingPage)
          .values({ tenantId, ...input, updatedByUserId: userId })
          .returning();
      });

      return c.json({ content: toContent(row) });
    });
}

/**
 * Public, pre-tenant-context landing content for the current host — used by
 * the marketing page (Phase 4). Reused host-resolution shape as `qr`'s and
 * `inquiry`'s own public routes; no dedicated `public-stations` helper
 * exists yet to share (see this plan's Phase 3 note) — if `public-stations`
 * lands its own shared host-resolution helper later, repoint this to it
 * instead of duplicating the terminal-status check inline.
 *
 * Deliberately reads via `withAdmin` (no tenant session exists pre-auth) and
 * returns only an explicit, narrow shape — never a raw row.
 */
export async function getPublicLandingPageContent(tenantId: string) {
  const [landingRow] = await withAdmin((tx) =>
    tx.select().from(chronoLandingPage).where(eq(chronoLandingPage.tenantId, tenantId)).limit(1),
  );

  const branchRows = await withAdmin((tx) =>
    tx
      .select({
        id: chronoBranch.id,
        name: chronoBranch.name,
        address: chronoBranch.address,
        operatingHours: chronoBranch.operatingHours,
        contactNumber: chronoBranch.contactNumber,
        email: chronoBranch.email,
      })
      .from(chronoBranch)
      .where(eq(chronoBranch.tenantId, tenantId)),
  );

  const [stationCountRow] = await withAdmin((tx) =>
    tx
      .select({ id: chronoStation.id })
      .from(chronoStation)
      .where(and(eq(chronoStation.tenantId, tenantId), ne(chronoStation.status, "offline")))
      .limit(1),
  );

  return {
    content: toContent(landingRow),
    branches: branchRows,
    hasStations: stationCountRow !== undefined,
  };
}
