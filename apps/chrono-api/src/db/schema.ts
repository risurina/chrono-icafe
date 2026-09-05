import { pgTable, text, timestamp, index, integer } from "drizzle-orm/pg-core";
import { createId } from "agora";
import * as base from "agora/db/schema";
import { chronoBranch } from "../modules/branch/schema";
import { chronoMemberProfile } from "../modules/member/schema";
import { chronoStationGroup, chronoStation } from "../modules/station/schema";
import { chronoShift } from "../modules/shift/schema";
import { chronoReservation } from "../modules/reservation/schema";
import { chronoMemberReservationRestriction } from "../modules/reservation/restriction-schema";
import { chronoReservationPolicy } from "../modules/reservation/policy-schema";
import {
  chronoProduct,
  chronoSale,
  chronoSaleItem,
  chronoSalePayment,
} from "../modules/pos/schema";
import { chronoWallet, chronoWalletTransaction } from "../modules/wallet/schema";
import { chronoDeviceProvisioningToken, chronoDevice } from "../modules/device/schema";
import { chronoLoyaltyAccount, chronoLoyaltyTransaction } from "../modules/loyalty/schema";
import { chronoSession } from "../modules/session/schema";
import { chronoPayment, chronoPaymentEvent } from "../modules/payment/schema";
import {
  chronoCreditProduct,
  chronoCreditGrant,
  chronoCreditPurchase,
  chronoCreditGrantLedgerEntry,
} from "../modules/credit/schema";
import { chronoVoucher } from "../modules/voucher/schema";
import { chronoPromo, chronoPromoRedemption } from "../modules/promo/schema";
import { chronoSecurityAlert } from "../modules/security-alert/schema";
import { chronoQrTokenUse } from "../modules/qr/schema";
import { chronoInquiry, chronoInquiryMessage } from "../modules/inquiry/schema";
import { chronoLandingPage } from "../modules/landing-page/schema";
import { chronoAppUsageEvent } from "../modules/app-usage/schema";

export {
  chronoBranch,
  chronoMemberProfile,
  chronoStationGroup,
  chronoStation,
  chronoShift,
  chronoReservation,
  chronoMemberReservationRestriction,
  chronoReservationPolicy,
  chronoProduct,
  chronoSale,
  chronoSaleItem,
  chronoSalePayment,
  chronoWallet,
  chronoWalletTransaction,
  chronoDeviceProvisioningToken,
  chronoDevice,
  chronoLoyaltyAccount,
  chronoLoyaltyTransaction,
  chronoSession,
  chronoPayment,
  chronoPaymentEvent,
  chronoCreditProduct,
  chronoCreditGrant,
  chronoCreditPurchase,
  chronoCreditGrantLedgerEntry,
  chronoVoucher,
  chronoPromo,
  chronoPromoRedemption,
  chronoSecurityAlert,
  chronoQrTokenUse,
  chronoInquiry,
  chronoInquiryMessage,
  chronoLandingPage,
  chronoAppUsageEvent,
};

/**
 * This app's database schema = the foundation's tenancy tables + this app's own
 * tenant-scoped tables. drizzle-kit reads this file, so migrations cover both.
 *
 * To add a resource: define a table with a `tenantId` referencing
 * base.organization.id, then add its name to APP_TENANT_TABLES (for RLS).
 */

// Re-export the foundation tables so migrations include them.
export const {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  organizationRole,
  platformAuthProvider,
  notificationTemplate,
  domain,
  tenantBranding,
  tenantLandingPage,
  tenantFeatureFlag,
  tenantMember,
  tenantMemberSession,
  tenantMemberToken,
  tenantMemberOAuthAccount,
  customer,
  customerSession,
  customerToken,
  apiKey,
  webhookEndpoint,
  twoFactor,
  auditEvent,
  tenantSubscription,
  tenantSubscriptionEvent,
  billingEvent,
  paymentTransaction,
  tenantSecurityPolicy,
  tenantOnboardingDismissal,
  tenantSsoConnection,
  tenantIntegration,
  platformAuditEvent,
  platformImpersonationGrant,
  platformCustomRole,
  organizationPolicyAcceptance,
  platformSecurityPolicy,
  platformAnnouncement,
  announcementDelivery,
  platformSetting,
  plan,
  planPrice,
  platformIntegration,
  platformIntegrationAccount,
  job,
  featureDefinition,
  supportTicket,
  supportTicketMessage,
  tenantUsageQuota,
  tenantUsageCounter,
} = base;

/** EXAMPLE app resource — copy this pattern for your real tables. */
export const project = pgTable(
  "Projects",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [index("project_tenant_idx").on(t.tenantId)],
);

export const storedFile = pgTable(
  "StoredFiles",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    storageKey: text("storageKey").notNull(),
    // Optional caller-supplied namespace (e.g. "avatars", "invoices") — nested
    // under the tenant's folder in the storage key. Null keeps a file at the
    // tenant folder's root, matching the original (pre-feature) key shape.
    feature: text("feature"),
    visibility: text("visibility").notNull(),
    originalName: text("originalName").notNull(),
    contentType: text("contentType").notNull(),
    sizeBytes: integer("sizeBytes").notNull().default(0),
    status: text("status").notNull().default("pending"),
    uploadedBy: text("uploadedBy").references(() => base.user.id, { onDelete: "set null" }),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
    deletedAt: timestamp("deletedAt"),
  },
  (t) => [index("stored_file_tenant_idx").on(t.tenantId)],
);

/**
 * Per-user notification feed (the dashboard bell). `type` is a free-text
 * discriminator (e.g. "invite_accepted", "webhook_disabled"), not a DB enum,
 * so a new trigger point never needs a migration. Reads are always scoped to
 * BOTH tenantId (RLS) AND recipientUserId (in the route, never trust a
 * client-supplied recipient) — this is per-user, not just per-tenant.
 */
export const tenantNotification = pgTable(
  "TenantNotifications",
  {
    id: text("id").primaryKey().$defaultFn(createId),
    tenantId: text("tenantId")
      .notNull()
      .references(() => base.organization.id, { onDelete: "cascade" }),
    recipientUserId: text("recipientUserId")
      .notNull()
      .references(() => base.user.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    // Optional deep-link (e.g. "/dashboard/settings/roles"), rendered as a
    // link if present. Never a full URL to another tenant.
    href: text("href"),
    // Who performed the action this notification is about (nullable — some
    // events have no single actor, e.g. a system/cron-triggered one).
    // `actorName` is denormalized (captured at write time), not just a join,
    // so an actor account deleted later never breaks notification history —
    // same pattern as `storedFile.uploadedBy`.
    actorUserId: text("actorUserId").references(() => base.user.id, {
      onDelete: "set null",
    }),
    actorName: text("actorName"),
    readAt: timestamp("readAt"),
    createdAt: timestamp("createdAt").notNull().defaultNow(),
  },
  (t) => [
    index("tenant_notification_tenant_idx").on(t.tenantId),
    index("tenant_notification_recipient_idx").on(t.recipientUserId),
  ],
);

// `tenantUsageQuota` / `tenantUsageCounter` are generic multi-tenant usage
// tables and now live in the foundation tenant schema (re-exported from `base`
// above). Their RLS registration stays in APP_TENANT_TABLES below, matching how
// other foundation tenant tables (tenant_subscription, tenant_integration, …)
// are opted in here.

/** This app's tenant-scoped tables that need RLS (added to the base ones). */
export const APP_TENANT_TABLES = [
  "Projects",
  "StoredFiles",
  "TenantNotifications",
  "AuditEvents",
  "TenantSubscriptions",
  "TenantSubscriptionEvents",
  "PaymentTransactions",
  "TenantSecurityPolicies",
  "TenantOnboardingDismissals",
  "TenantSsoConnections",
  "TenantIntegrations",
  "TenantUsageQuotas",
  "TenantUsageCounters",
  "ChronoBranches",
  "ChronoMemberProfiles",
  "ChronoStationGroups",
  "ChronoStations",
  "ChronoShifts",
  "ChronoReservations",
  "ChronoMemberReservationRestrictions",
  "ChronoReservationPolicies",
  "ChronoProducts",
  "ChronoSales",
  "ChronoSaleItems",
  "ChronoSalePayments",
  "ChronoWallets",
  "ChronoWalletTransactions",
  "ChronoDeviceProvisioningTokens",
  "ChronoDevices",
  "ChronoLoyaltyAccounts",
  "ChronoLoyaltyTransactions",
  "ChronoSessions",
  "ChronoPayments",
  "ChronoPaymentEvents",
  "ChronoCreditProducts",
  "ChronoCreditGrants",
  "ChronoCreditPurchases",
  "ChronoCreditGrantLedgerEntries",
  "ChronoVouchers",
  "ChronoPromos",
  "ChronoPromoRedemptions",
  "ChronoSecurityAlerts",
  "ChronoQrTokenUses",
  "ChronoInquiries",
  "ChronoInquiryMessages",
  "ChronoLandingPages",
  "ChronoAppUsageEvents",
] as const;
