import "dotenv/config";
import "./auth-bootstrap";
import { randomBytes } from "node:crypto";
import { auth } from "agora/auth";
import { adminDb, withTenant, withAdmin, schema, eq, and, pool, adminPool } from "agora/db";
import { hashMemberPassword } from "agora/member-auth";
import { createId } from "agora";
import { project, tenantSubscription, tenantSubscriptionEvent } from "./db/schema";
import { chronoBranch } from "./modules/branch/schema";
import { chronoStation, chronoStationGroup } from "./modules/station/schema";
import { chronoDevice } from "./modules/device/schema";
import {
  chronoCreditProduct,
  chronoCreditGrant,
  chronoCreditPurchase,
  chronoCreditGrantLedgerEntry,
} from "./modules/credit/schema";
import { chronoWallet, chronoWalletTransaction } from "./modules/wallet/schema";

/**
 * Seed two demo tenants. Each gets a staff owner, a customer, and projects.
 *   acme    → staff owner@acme.test    · customer member@acme.test
 *   contoso → staff owner@contoso.test · customer member@contoso.test
 *   (all passwords: Password123!)
 *
 * Staff users are created through Better Auth. Customers are the separate
 * tenant_member pool (RLS-forced, so inserted via withTenant).
 */
const TENANTS = [
  {
    slug: "acme",
    name: "Acme Corp",
    ownerName: "Acme Owner",
    ownerEmail: "owner@acme.test",
    memberName: "Acme Customer",
    memberEmail: "member@acme.test",
    // A third project so acme/contoso have distinguishable project counts —
    // needed for the platform metrics per-tenant table's cross-tenant no-leak
    // e2e assertion (apps/web/e2e/tests/platform-admin/metrics.spec.ts).
    projects: ["First Project", "Second Project", "Third Project"],
  },
  {
    slug: "contoso",
    name: "Contoso Ltd",
    ownerName: "Contoso Owner",
    ownerEmail: "owner@contoso.test",
    memberName: "Contoso Customer",
    memberEmail: "member@contoso.test",
    projects: ["First Project", "Second Project"],
  },
  {
    slug: "globex",
    name: "Globex Inc",
    ownerName: "Globex Owner",
    ownerEmail: "owner@globex.test",
    memberName: "Globex Customer",
    memberEmail: "member@globex.test",
    // Trial-status tenant — gives the admin dashboard's trial-tenant KPI and
    // "tenants past due" section something real to assert on
    // (apps/web/e2e/tests/platform-admin/dashboard.spec.ts).
    projects: ["First Project"],
  },
];

const PASSWORD = "Password123!";

// A literal replica of karta-oikos/chrono's "gaming" demo tenant identities —
// same emails, same shared placeholder password — kept separate from the
// generic `.test`-tenant PASSWORD above so the two never get conflated.
// SECURITY: this is a known, publicly-guessable placeholder password;
// never seed it against a database backing a real production hostname.
const GAMING_PASSWORD = "Izur1234!";
const GAMING_OWNER_EMAIL = "gaming@izur.com.ph";
const GAMING_STAFF_EMAIL = "staff-gaming@izur.com.ph";
const GAMING_CUSTOMER_EMAIL = "player-gaming@izur.com.ph";
const GAMING_DOMAIN_HOSTNAME = "chrono2.izur.com.ph";

// Approved in both acme and contoso — one global identity, two independent
// linked tenantMember rows (agora/customer-auth). Sign in once at the apex
// /portal/login, then visit either tenant's /portal with no second login.
const GLOBAL_CUSTOMER_EMAIL = "global@customer.test";
const GLOBAL_CUSTOMER_NAME = "Global Customer";
const GLOBAL_CUSTOMER_TENANT_SLUGS = ["acme", "contoso"];

const PLATFORM_ADMIN_EMAIL = "platform@agora.test";
const PLATFORM_ADMIN_NAME = "Platform Admin";

const PLATFORM_VIEWER_EMAIL = "platform-viewer@agora.test";
const PLATFORM_VIEWER_NAME = "Platform Viewer";

const CHRONO_SUPERADMIN_EMAIL = "admin@chrono.izur.com.ph";
const CHRONO_SUPERADMIN_NAME = "Chrono Admin";

// tenantSubscription is unique per tenant (tenant_subscription_tenant_uq), so
// each seeded org gets exactly one row here, covering the three statuses the
// admin dashboard's KPIs and e2e spec need real data for.
const SUBSCRIPTIONS: Record<
  string,
  { plan: string; status: string; seats: number }
> = {
  acme: { plan: "pro", status: "active", seats: 10 },
  contoso: { plan: "pro", status: "past_due", seats: 10 },
  globex: { plan: "free", status: "trialing", seats: 3 },
  gaming: { plan: "pro", status: "active", seats: 10 },
};

async function ensureUser(email: string, name: string, password = PASSWORD): Promise<string> {
  try {
    const res = await auth.api.signUpEmail({
      body: { email, password, name },
    });
    return res.user.id;
  } catch {
    // Already exists → look it up.
    const [existing] = await adminDb
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email))
      .limit(1);
    if (!existing) throw new Error(`Could not create or find user ${email}`);
    return existing.id;
  }
}

async function ensureOrg(slug: string, name: string): Promise<string> {
  const [existing] = await adminDb
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.slug, slug))
    .limit(1);
  if (existing) return existing.id;
  const id = createId();
  await adminDb.insert(schema.organization).values({ id, name, slug });
  return id;
}

async function ensureMember(orgId: string, userId: string, role = "owner") {
  const [existing] = await adminDb
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(eq(schema.member.userId, userId))
    .limit(1);
  if (existing) return;
  await adminDb.insert(schema.member).values({
    id: createId(),
    organizationId: orgId,
    userId,
    role,
  });
}

/**
 * A dedicated platform-admin user with no tenant membership — kept separate from
 * every tenant owner so the `platformRole` authorization dimension stays
 * independent of the `member.role` ladder (see `.ai/plans/agora/archive/platform-admin-portal`).
 * Granted the "admin" platform role (every platform permission); "viewer" exists
 * as a read-only role but has no seeded holder.
 */
async function ensurePlatformAdmin() {
  const userId = await ensureUser(PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_NAME);
  await adminDb
    .update(schema.user)
    .set({ platformRole: "admin", role: "impersonator" })
    .where(eq(schema.user.id, userId));
}

/**
 * A read-only platform-admin holder — previously unseeded (only "admin" had
 * a seeded holder), needed for the dashboard's role-gate e2e case.
 */
async function ensurePlatformViewer() {
  const userId = await ensureUser(PLATFORM_VIEWER_EMAIL, PLATFORM_VIEWER_NAME);
  await adminDb
    .update(schema.user)
    .set({ platformRole: "viewer", role: "impersonator" })
    .where(eq(schema.user.id, userId));
}

/**
 * Chrono's own real platform-admin holder, kept separate from the generic
 * platform@agora.test demo admin above — grants the "admin" platform role
 * (every platform permission) to admin@chrono.izur.com.ph.
 */
async function ensureChronoSuperAdmin() {
  const userId = await ensureUser(CHRONO_SUPERADMIN_EMAIL, CHRONO_SUPERADMIN_NAME);
  await adminDb
    .update(schema.user)
    .set({ platformRole: "admin", role: "impersonator" })
    .where(eq(schema.user.id, userId));
}

/**
 * Idempotently seed one `tenantSubscription` row per tenant (unique per
 * tenant via `tenant_subscription_tenant_uq`) — RLS-forced, tenant-scoped
 * table, so always via `withAdmin()` cross-tenant, never a bare `adminDb`
 * read/write. Gives the platform admin dashboard's trial/past-due KPIs real
 * data locally (`apps/api/src/routes/rpc-admin-metrics.ts`).
 */
async function ensureSubscription(
  orgId: string,
  sub: { plan: string; status: string; seats: number },
) {
  const existing = await withAdmin((tx) =>
    tx
      .select({ id: tenantSubscription.id })
      .from(tenantSubscription)
      .where(eq(tenantSubscription.tenantId, orgId)),
  );
  if (existing.length > 0) return;
  await withAdmin((tx) =>
    tx.insert(tenantSubscription).values({
      id: createId(),
      tenantId: orgId,
      plan: sub.plan,
      status: sub.status,
      seats: sub.seats,
    }),
  );
}

/**
 * Seed one recorded `tenantSubscriptionEvent` row for a tenant, if it doesn't
 * already have one — gives `/admin/reports`'s growth/plan-changes/churn
 * sections something real and distinguishable to assert on
 * (`apps/web/e2e/tests/platform-admin/reports.spec.ts`). RLS-forced,
 * tenant-scoped table, so always via `withTenant` — a bare `adminDb.insert`
 * would silently write zero rows (fail-closed, no `app.tenant_id` set).
 */
async function ensureSubscriptionEvent(
  orgId: string,
  event: {
    previousPlan: string | null;
    newPlan: string;
    previousStatus: string | null;
    newStatus: string;
    source: string;
  },
) {
  await withTenant(orgId, async (tx) => {
    const existing = await tx
      .select({ id: tenantSubscriptionEvent.id })
      .from(tenantSubscriptionEvent)
      .where(eq(tenantSubscriptionEvent.source, event.source));
    if (existing.length > 0) return;
    await tx.insert(tenantSubscriptionEvent).values({
      id: createId(),
      tenantId: orgId,
      previousPlan: event.previousPlan,
      newPlan: event.newPlan,
      previousStatus: event.previousStatus,
      newStatus: event.newStatus,
      source: event.source,
    });
  });
}

/**
 * Seed demo branches + stations for `acme` so the public `/public/stations`
 * grouped-by-branch view (and the `/stations` page) has real, multi-branch
 * data to render locally. Idempotent — checked by the same tenant+code unique
 * constraint the schema already enforces.
 */
async function ensureBranchesAndStations(orgId: string) {
  const BRANCHES = [
    {
      code: "main",
      name: "Acme Main Branch",
      groups: [
        { code: "regular", name: "Regular", hourlyRate: "40.00", memberRate: "32.00" },
        { code: "premium", name: "Premium", hourlyRate: "70.00", memberRate: "56.00" },
      ],
      stations: [
        { stationNumber: "PC-01", name: "Station 1", stationType: "pc", status: "available", group: "regular" },
        { stationNumber: "PC-02", name: "Station 2", stationType: "pc", status: "available", group: "regular" },
        { stationNumber: "PC-03", name: "Station 3", stationType: "pc", status: "maintenance", group: "premium" },
        { stationNumber: "PC-04", name: "Station 4", stationType: "pc", status: "offline", group: "premium" },
      ],
    },
    {
      code: "vip",
      name: "Acme VIP Lounge",
      groups: [{ code: "vip", name: "VIP", hourlyRate: "120.00", memberRate: "96.00" }],
      stations: [
        { stationNumber: "VIP-01", name: "VIP Seat 1", stationType: "vip", status: "available", group: "vip" },
        { stationNumber: "VIP-02", name: "VIP Seat 2", stationType: "vip", status: "available", group: "vip" },
        { stationNumber: "VIP-03", name: "VIP Seat 3", stationType: "vip", status: "maintenance", group: "vip" },
      ],
    },
  ];

  await withTenant(orgId, async (tx) => {
    for (const b of BRANCHES) {
      const [existingBranch] = await tx
        .select({ id: chronoBranch.id })
        .from(chronoBranch)
        .where(eq(chronoBranch.code, b.code));

      let branchId = existingBranch?.id;
      if (!branchId) {
        const newBranchId = createId();
        await tx
          .insert(chronoBranch)
          .values({ id: newBranchId, tenantId: orgId, name: b.name, code: b.code, status: "active" });
        branchId = newBranchId;
      }

      const groupIdByCode: Record<string, string> = {};
      for (const g of b.groups) {
        const [existingGroup] = await tx
          .select({ id: chronoStationGroup.id })
          .from(chronoStationGroup)
          .where(and(eq(chronoStationGroup.branchId, branchId), eq(chronoStationGroup.code, g.code)))
          .limit(1);
        if (existingGroup) {
          groupIdByCode[g.code] = existingGroup.id;
          continue;
        }
        const newGroupId = createId();
        await tx.insert(chronoStationGroup).values({
          id: newGroupId,
          tenantId: orgId,
          branchId,
          name: g.name,
          code: g.code,
          hourlyRate: g.hourlyRate,
          memberRate: g.memberRate,
        });
        groupIdByCode[g.code] = newGroupId;
      }

      for (const s of b.stations) {
        const [existingStation] = await tx
          .select({ id: chronoStation.id })
          .from(chronoStation)
          .where(
            and(eq(chronoStation.branchId, branchId), eq(chronoStation.stationNumber, s.stationNumber)),
          )
          .limit(1);
        if (existingStation) continue;

        await tx.insert(chronoStation).values({
          id: createId(),
          tenantId: orgId,
          branchId,
          stationGroupId: groupIdByCode[s.group],
          name: s.name,
          stationNumber: s.stationNumber,
          stationType: s.stationType,
          status: s.status,
        });
      }
    }
  });
}

/**
 * Seed one approved device per acme station, four sellable credit packages
 * (one locked to the main branch's "regular" tier, three spendable anywhere),
 * and a demo wallet + credit-grant ledger trail for acme's customer — so the
 * device/credit/wallet modules (schema-only until now) have real local demo
 * data to render against. Idempotent: devices are looked up by stationId
 * (fingerprints are random, so can't double as the idempotency key), products
 * by their unique (tenantId, code), and the wallet/purchase/grant/ledger rows
 * by the customer's existing wallet/purchase presence.
 */
async function seedGamingDemoData(orgId: string, ownerUserId: string, memberEmail: string) {
  await withTenant(orgId, async (tx) => {
    // --- devices: one approved device per station -------------------------
    const stations = await tx
      .select({ id: chronoStation.id, branchId: chronoStation.branchId })
      .from(chronoStation);

    for (const station of stations) {
      const [existingDevice] = await tx
        .select({ id: chronoDevice.id })
        .from(chronoDevice)
        .where(eq(chronoDevice.stationId, station.id))
        .limit(1);
      if (existingDevice) continue;

      await tx.insert(chronoDevice).values({
        id: createId(),
        tenantId: orgId,
        branchId: station.branchId,
        stationId: station.id,
        deviceFingerprint: randomBytes(16).toString("hex"),
        tokenHash: randomBytes(32).toString("hex"),
        status: "approved",
        connectivityStatus: "online",
        approvedByUserId: ownerUserId,
        approvedAt: new Date(),
      });
    }

    // --- credit products ----------------------------------------------------
    const [mainBranch] = await tx
      .select({ id: chronoBranch.id })
      .from(chronoBranch)
      .where(eq(chronoBranch.code, "main"))
      .limit(1);
    const [regularGroup] = mainBranch
      ? await tx
          .select({ id: chronoStationGroup.id })
          .from(chronoStationGroup)
          .where(
            and(eq(chronoStationGroup.branchId, mainBranch.id), eq(chronoStationGroup.code, "regular")),
          )
          .limit(1)
      : [];

    const PRODUCTS = [
      {
        code: "regular-60",
        name: "Regular Hour Pack",
        quantityMinutes: 60,
        priceAmount: "200.00",
        creditPolicy: "strict_group_only",
        stationGroupId: regularGroup?.id ?? null,
      },
      {
        code: "any-station-30",
        name: "Any-Station 30",
        quantityMinutes: 30,
        priceAmount: "150.00",
        creditPolicy: "any_station",
        stationGroupId: null,
      },
      {
        code: "weekend-bundle",
        name: "Weekend Gamer Pack",
        quantityMinutes: 180,
        priceAmount: "700.00",
        creditPolicy: "any_station",
        stationGroupId: null,
      },
    ];

    const productIdByCode: Record<string, string> = {};
    for (const p of PRODUCTS) {
      const [existingProduct] = await tx
        .select({ id: chronoCreditProduct.id })
        .from(chronoCreditProduct)
        .where(eq(chronoCreditProduct.code, p.code))
        .limit(1);
      if (existingProduct) {
        productIdByCode[p.code] = existingProduct.id;
        continue;
      }
      const newProductId = createId();
      await tx.insert(chronoCreditProduct).values({
        id: newProductId,
        tenantId: orgId,
        name: p.name,
        code: p.code,
        status: "active",
        quantityMinutes: p.quantityMinutes,
        priceAmount: p.priceAmount,
        stationGroupId: p.stationGroupId,
        creditPolicy: p.creditPolicy,
      });
      productIdByCode[p.code] = newProductId;
    }

    // --- wallet + a demo purchase for acme's customer ------------------------
    const [member] = await tx
      .select({ id: schema.tenantMember.id })
      .from(schema.tenantMember)
      .where(eq(schema.tenantMember.email, memberEmail))
      .limit(1);
    if (!member) return;

    let [wallet] = await tx
      .select({ id: chronoWallet.id, balance: chronoWallet.balance })
      .from(chronoWallet)
      .where(eq(chronoWallet.memberId, member.id))
      .limit(1);

    if (!wallet) {
      const newWalletId = createId();
      await tx.insert(chronoWallet).values({
        id: newWalletId,
        tenantId: orgId,
        memberId: member.id,
        balance: "1000.00",
      });
      await tx.insert(chronoWalletTransaction).values({
        id: createId(),
        tenantId: orgId,
        walletId: newWalletId,
        memberId: member.id,
        type: "credit",
        amount: "1000.00",
        balanceBefore: "0.00",
        balanceAfter: "1000.00",
        reason: "seed top-up",
        referenceType: "manual_topup",
      });
      wallet = { id: newWalletId, balance: "1000.00" };
    }

    const weekendProductId = productIdByCode["weekend-bundle"];
    const [existingPurchase] = weekendProductId
      ? await tx
          .select({ id: chronoCreditPurchase.id })
          .from(chronoCreditPurchase)
          .where(
            and(
              eq(chronoCreditPurchase.memberId, member.id),
              eq(chronoCreditPurchase.productId, weekendProductId),
            ),
          )
          .limit(1)
      : [];
    if (existingPurchase || !weekendProductId) return;

    const price = "700.00";
    const balanceBefore = wallet.balance;
    const balanceAfter = (Number(balanceBefore) - Number(price)).toFixed(2);

    const purchaseWalletTxId = createId();
    await tx.insert(chronoWalletTransaction).values({
      id: purchaseWalletTxId,
      tenantId: orgId,
      walletId: wallet.id,
      memberId: member.id,
      type: "debit",
      amount: `-${price}`,
      balanceBefore,
      balanceAfter,
      reason: "seed credit purchase: weekend-bundle",
      referenceType: "credit_purchase",
    });
    await tx
      .update(chronoWallet)
      .set({ balance: balanceAfter })
      .where(eq(chronoWallet.id, wallet.id));

    const grantId = createId();
    await tx.insert(chronoCreditGrant).values({
      id: grantId,
      tenantId: orgId,
      memberId: member.id,
      productId: weekendProductId,
      creditPolicy: "any_station",
      originalQuantity: 180,
      remainingQuantity: 180,
      status: "granted",
    });

    const purchaseId = createId();
    await tx.insert(chronoCreditPurchase).values({
      id: purchaseId,
      tenantId: orgId,
      memberId: member.id,
      productId: weekendProductId,
      grantId,
      quantityMinutes: 180,
      priceAmount: price,
      walletTransactionId: purchaseWalletTxId,
    });

    await tx.insert(chronoCreditGrantLedgerEntry).values({
      id: createId(),
      tenantId: orgId,
      grantId,
      memberId: member.id,
      type: "granted",
      quantityDelta: 180,
      quantityBefore: 0,
      quantityAfter: 180,
      reason: "seed credit purchase",
      referenceType: "purchase",
      referenceId: purchaseId,
    });
  });
}

/**
 * Idempotently point a hostname at a tenant (`agora/db/schema`'s `domain`
 * table, `"Domains"`) — `resolveOrgFromRequest()`
 * (`packages/agora/src/core/server/host.ts`) only checks `verifiedAt IS NOT
 * NULL`, so setting it here is sufficient for local/demo routing (no real DNS
 * verification flow is exercised).
 */
async function ensureCustomDomain(orgId: string, hostname: string) {
  const [existing] = await adminDb
    .select({ id: schema.domain.id })
    .from(schema.domain)
    .where(eq(schema.domain.hostname, hostname))
    .limit(1);
  if (existing) return;
  await adminDb.insert(schema.domain).values({
    id: createId(),
    tenantId: orgId,
    hostname,
    verifiedAt: new Date(),
    isPrimary: true,
  });
}

/**
 * A literal replica of karta-oikos/chrono's "gaming" demo tenant — owner,
 * staff, and customer identities matching oikos's exact emails/password,
 * reachable at `chrono2.izur.com.ph` via a seeded custom domain — layered on
 * top of the same station-tier/device/credit/wallet demo data acme gets
 * (`ensureBranchesAndStations` / `seedGamingDemoData`, both already generic
 * over `orgId`).
 */
async function seedGamingTenant(): Promise<string> {
  const ownerUserId = await ensureUser(GAMING_OWNER_EMAIL, "Gaming Owner", GAMING_PASSWORD);
  const orgId = await ensureOrg("gaming", "Gaming Lounge");
  await ensureMember(orgId, ownerUserId, "owner");

  const staffUserId = await ensureUser(GAMING_STAFF_EMAIL, "Gaming Staff", GAMING_PASSWORD);
  await ensureMember(orgId, staffUserId, "staff");

  await ensureCustomDomain(orgId, GAMING_DOMAIN_HOSTNAME);

  const sub = SUBSCRIPTIONS.gaming;
  if (sub) await ensureSubscription(orgId, sub);

  await withTenant(orgId, async (tx) => {
    const [existingMember] = await tx
      .select({ id: schema.tenantMember.id })
      .from(schema.tenantMember)
      .where(eq(schema.tenantMember.email, GAMING_CUSTOMER_EMAIL))
      .limit(1);
    if (!existingMember) {
      await tx.insert(schema.tenantMember).values({
        tenantId: orgId,
        email: GAMING_CUSTOMER_EMAIL,
        name: "Player One",
        passwordHash: await hashMemberPassword(GAMING_PASSWORD),
      });
    }
  });

  await ensureBranchesAndStations(orgId);
  await seedGamingDemoData(orgId, ownerUserId, GAMING_CUSTOMER_EMAIL);

  // eslint-disable-next-line no-console
  console.log(
    `Seeded gaming (owner ${GAMING_OWNER_EMAIL} · staff ${GAMING_STAFF_EMAIL} · customer ${GAMING_CUSTOMER_EMAIL} / ${GAMING_PASSWORD}) @ ${GAMING_DOMAIN_HOSTNAME}`,
  );

  return orgId;
}

/**
 * Seed one global customer (agora/customer-auth, cookie `agora_customer`)
 * approved in every tenant listed in `tenantIds` — a linked `tenantMember`
 * row (`customerId` set, `status: "active"`) per tenant, created the same
 * way `POST /portal/customer/apply` would. Exercises the multi-tenant
 * session-bridge flow (`.ai/plans/agora/archive/global-customers`) without
 * driving the UI.
 */
async function ensureGlobalCustomer(tenantIds: string[]): Promise<void> {
  const [existing] = await adminDb
    .select({ id: schema.customer.id })
    .from(schema.customer)
    .where(eq(schema.customer.email, GLOBAL_CUSTOMER_EMAIL))
    .limit(1);

  let customerId = existing?.id;
  if (!customerId) {
    const [created] = await adminDb
      .insert(schema.customer)
      .values({
        email: GLOBAL_CUSTOMER_EMAIL,
        name: GLOBAL_CUSTOMER_NAME,
        passwordHash: await hashMemberPassword(PASSWORD),
      })
      .returning({ id: schema.customer.id });
    if (!created) throw new Error("Could not create global customer");
    customerId = created.id;
  }

  for (const tenantId of tenantIds) {
    await withTenant(tenantId, async (tx) => {
      const [existingLink] = await tx
        .select({ id: schema.tenantMember.id })
        .from(schema.tenantMember)
        .where(eq(schema.tenantMember.email, GLOBAL_CUSTOMER_EMAIL))
        .limit(1);
      if (existingLink) return;
      await tx.insert(schema.tenantMember).values({
        tenantId,
        email: GLOBAL_CUSTOMER_EMAIL,
        name: GLOBAL_CUSTOMER_NAME,
        // Unusable placeholder — this row only ever authenticates via the
        // global customer session, never a tenant-local password (mirrors
        // agora/customer-auth's own apply route).
        passwordHash: `scrypt$${randomBytes(16).toString("hex")}$${randomBytes(64).toString("hex")}`,
        customerId,
        status: "active",
      });
    });
  }
}

async function seed() {
  await ensurePlatformAdmin();
  await ensurePlatformViewer();
  await ensureChronoSuperAdmin();

  const orgIdBySlug: Record<string, string> = {};
  orgIdBySlug.gaming = await seedGamingTenant();

  for (const t of TENANTS) {
    const userId = await ensureUser(t.ownerEmail, t.ownerName);
    const orgId = await ensureOrg(t.slug, t.name);
    orgIdBySlug[t.slug] = orgId;
    await ensureMember(orgId, userId);

    // acme also gets a "staff"-ranked (non-owner) member — needed for the
    // billing:manage role-gate e2e case (owner-only), which otherwise has no
    // seeded staff account below owner to test against
    // (apps/web/e2e/tests/billing/paymongo-checkout.spec.ts).
    if (t.slug === "acme") {
      const staffUserId = await ensureUser("staff@acme.test", "Acme Staff");
      await ensureMember(orgId, staffUserId, "staff");
      await ensureBranchesAndStations(orgId);
    }

    const sub = SUBSCRIPTIONS[t.slug];
    if (sub) await ensureSubscription(orgId, sub);

    await withTenant(orgId, async (tx) => {
      const existing = await tx.select().from(project);
      if (existing.length === 0) {
        for (const name of t.projects) {
          await tx.insert(project).values({ id: createId(), tenantId: orgId, name });
        }
      }

      // Seed a customer (separate pool) if not present.
      const [existingMember] = await tx
        .select({ id: schema.tenantMember.id })
        .from(schema.tenantMember)
        .where(eq(schema.tenantMember.email, t.memberEmail))
        .limit(1);
      if (!existingMember) {
        await tx.insert(schema.tenantMember).values({
          tenantId: orgId,
          email: t.memberEmail,
          name: t.memberName,
          passwordHash: await hashMemberPassword(PASSWORD),
        });
      }
    });

    if (t.slug === "acme") {
      await seedGamingDemoData(orgId, userId, t.memberEmail);
    }

    // eslint-disable-next-line no-console
    console.log(
      `Seeded ${t.slug} (staff ${t.ownerEmail} · customer ${t.memberEmail} / ${PASSWORD})`,
    );
  }

  const globalCustomerTenantIds = GLOBAL_CUSTOMER_TENANT_SLUGS.map(
    (slug) => orgIdBySlug[slug],
  ).filter((id): id is string => !!id);
  if (globalCustomerTenantIds.length > 0) {
    await ensureGlobalCustomer(globalCustomerTenantIds);
    // eslint-disable-next-line no-console
    console.log(
      `Seeded global customer ${GLOBAL_CUSTOMER_EMAIL} / ${PASSWORD} (approved in ${GLOBAL_CUSTOMER_TENANT_SLUGS.join(", ")})`,
    );
  }

  // acme: a recorded plan change (free → pro). contoso: a recorded
  // cancellation (pro → canceled) — distinct fixtures so /admin/reports'
  // aggregate-correctness e2e assertion can tell them apart.
  if (orgIdBySlug.acme) {
    await ensureSubscriptionEvent(orgIdBySlug.acme, {
      previousPlan: "free",
      newPlan: "pro",
      previousStatus: "active",
      newStatus: "active",
      source: "webhook",
    });
  }
  if (orgIdBySlug.contoso) {
    await ensureSubscriptionEvent(orgIdBySlug.contoso, {
      previousPlan: "pro",
      newPlan: "pro",
      previousStatus: "active",
      newStatus: "canceled",
      source: "manual_override",
    });
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded platform admin ${PLATFORM_ADMIN_EMAIL} / ${PASSWORD}`);
  // eslint-disable-next-line no-console
  console.log(`Seeded platform viewer ${PLATFORM_VIEWER_EMAIL} / ${PASSWORD}`);
}

seed()
  .then(async () => {
    await pool.end?.();
    if (adminPool !== pool) await adminPool.end?.();
    // eslint-disable-next-line no-console
    console.log("Seed complete.");
  })
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error("Seed failed:", err);
    await (pool.end?.() ?? Promise.resolve()).catch(() => {});
    process.exit(1);
  });
