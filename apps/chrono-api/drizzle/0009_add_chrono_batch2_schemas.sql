CREATE TABLE "ChronoCreditGrants" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"memberId" text NOT NULL,
	"productId" text,
	"stationGroupId" text,
	"creditPolicy" text DEFAULT 'any_station' NOT NULL,
	"unit" text DEFAULT 'minute' NOT NULL,
	"originalQuantity" integer NOT NULL,
	"remainingQuantity" integer NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"expiresAt" timestamp,
	"status" text DEFAULT 'granted' NOT NULL,
	"reason" text,
	"performedByUserId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoCreditGrantLedgerEntries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"grantId" text NOT NULL,
	"memberId" text NOT NULL,
	"type" text NOT NULL,
	"quantityDelta" integer NOT NULL,
	"quantityBefore" integer NOT NULL,
	"quantityAfter" integer NOT NULL,
	"reason" text,
	"referenceType" text,
	"referenceId" text,
	"performedByUserId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoCreditProducts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"unit" text DEFAULT 'minute' NOT NULL,
	"quantityMinutes" integer NOT NULL,
	"priceAmount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'PHP' NOT NULL,
	"stationGroupId" text,
	"creditPolicy" text DEFAULT 'any_station' NOT NULL,
	"validityDays" integer,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoCreditPurchases" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"memberId" text NOT NULL,
	"productId" text NOT NULL,
	"grantId" text,
	"quantityMinutes" integer NOT NULL,
	"priceAmount" numeric(12, 2) NOT NULL,
	"currency" text DEFAULT 'PHP' NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"walletTransactionId" text,
	"voidedAt" timestamp,
	"voidedByUserId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoInquiries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"tenantMemberId" text,
	"submitterName" text NOT NULL,
	"submitterEmail" text NOT NULL,
	"submitterPhone" text,
	"category" text NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"assignedToUserId" text,
	"closedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoInquiryMessages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"inquiryId" text NOT NULL,
	"authorType" text NOT NULL,
	"authorUserId" text,
	"authorMemberId" text,
	"body" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoLandingPages" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"heroTagline" text,
	"aboutBody" text,
	"amenitiesBody" text,
	"contactOverride" text,
	"ctaLabel" text,
	"ctaHref" text,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"updatedByUserId" text,
	CONSTRAINT "ChronoLandingPages_tenantId_unique" UNIQUE("tenantId")
);
--> statement-breakpoint
CREATE TABLE "ChronoLoyaltyAccounts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"memberId" text NOT NULL,
	"pointsBalance" integer DEFAULT 0 NOT NULL,
	"lifetimePoints" integer DEFAULT 0 NOT NULL,
	"tier" text DEFAULT 'bronze' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoLoyaltyTransactions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"accountId" text NOT NULL,
	"memberId" text NOT NULL,
	"type" text NOT NULL,
	"points" integer NOT NULL,
	"balanceBefore" integer NOT NULL,
	"balanceAfter" integer NOT NULL,
	"reason" text NOT NULL,
	"referenceType" text,
	"referenceId" text,
	"performedByUserId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoPromos" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"branchId" text,
	"name" text NOT NULL,
	"code" text,
	"description" text,
	"status" text DEFAULT 'active' NOT NULL,
	"discountType" text NOT NULL,
	"discountValue" numeric(12, 2) NOT NULL,
	"minSpend" numeric(12, 2),
	"startsAt" timestamp,
	"endsAt" timestamp NOT NULL,
	"maxRedemptions" integer,
	"maxRedemptionsPerMember" integer DEFAULT 1,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoPromoRedemptions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"promoId" text NOT NULL,
	"memberId" text,
	"saleId" text,
	"discountAmount" numeric(12, 2) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoQrTokenUses" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"stationId" text NOT NULL,
	"nonceHash" text NOT NULL,
	"consumedByMemberId" text,
	"consumedAt" timestamp,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoSecurityAlerts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"branchId" text NOT NULL,
	"stationId" text,
	"deviceId" text,
	"raisedBy" text NOT NULL,
	"reportedByUserId" text,
	"severity" text NOT NULL,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"metadata" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"acknowledgedByUserId" text,
	"acknowledgedAt" timestamp,
	"resolvedByUserId" text,
	"resolvedAt" timestamp,
	"resolutionNote" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoSessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"branchId" text NOT NULL,
	"stationId" text NOT NULL,
	"memberId" text NOT NULL,
	"startedByUserId" text,
	"status" text DEFAULT 'active' NOT NULL,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"scheduledEndAt" timestamp,
	"pausedAt" timestamp,
	"pausedDurationSeconds" integer DEFAULT 0 NOT NULL,
	"endedAt" timestamp,
	"actualBillableSeconds" integer,
	"rateSnapshot" numeric(12, 2) NOT NULL,
	"rateSource" text NOT NULL,
	"currency" text DEFAULT 'PHP' NOT NULL,
	"finalAmount" numeric(12, 2),
	"amountCharged" numeric(12, 2),
	"walletTransactionId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoVouchers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"promoId" text,
	"code" text NOT NULL,
	"discountType" text NOT NULL,
	"discountValue" numeric(12, 2) NOT NULL,
	"memberId" text,
	"status" text DEFAULT 'active' NOT NULL,
	"expiresAt" timestamp,
	"redeemedAt" timestamp,
	"redeemedAgainstSaleId" text,
	"cancelledAt" timestamp,
	"cancelReason" text,
	"issuedByUserId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChronoStations" ADD COLUMN "qrSecret" text;--> statement-breakpoint
ALTER TABLE "ChronoStations" ADD COLUMN "qrSecretVersion" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ChronoCreditGrants" ADD CONSTRAINT "ChronoCreditGrants_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditGrants" ADD CONSTRAINT "ChronoCreditGrants_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditGrants" ADD CONSTRAINT "ChronoCreditGrants_productId_ChronoCreditProducts_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."ChronoCreditProducts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditGrants" ADD CONSTRAINT "ChronoCreditGrants_stationGroupId_ChronoStationGroups_id_fk" FOREIGN KEY ("stationGroupId") REFERENCES "public"."ChronoStationGroups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditGrants" ADD CONSTRAINT "ChronoCreditGrants_performedByUserId_Users_id_fk" FOREIGN KEY ("performedByUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditGrantLedgerEntries" ADD CONSTRAINT "ChronoCreditGrantLedgerEntries_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditGrantLedgerEntries" ADD CONSTRAINT "ChronoCreditGrantLedgerEntries_grantId_ChronoCreditGrants_id_fk" FOREIGN KEY ("grantId") REFERENCES "public"."ChronoCreditGrants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditGrantLedgerEntries" ADD CONSTRAINT "ChronoCreditGrantLedgerEntries_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditGrantLedgerEntries" ADD CONSTRAINT "ChronoCreditGrantLedgerEntries_performedByUserId_Users_id_fk" FOREIGN KEY ("performedByUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditProducts" ADD CONSTRAINT "ChronoCreditProducts_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditProducts" ADD CONSTRAINT "ChronoCreditProducts_stationGroupId_ChronoStationGroups_id_fk" FOREIGN KEY ("stationGroupId") REFERENCES "public"."ChronoStationGroups"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditPurchases" ADD CONSTRAINT "ChronoCreditPurchases_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditPurchases" ADD CONSTRAINT "ChronoCreditPurchases_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditPurchases" ADD CONSTRAINT "ChronoCreditPurchases_productId_ChronoCreditProducts_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."ChronoCreditProducts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditPurchases" ADD CONSTRAINT "ChronoCreditPurchases_grantId_ChronoCreditGrants_id_fk" FOREIGN KEY ("grantId") REFERENCES "public"."ChronoCreditGrants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditPurchases" ADD CONSTRAINT "ChronoCreditPurchases_walletTransactionId_ChronoWalletTransactions_id_fk" FOREIGN KEY ("walletTransactionId") REFERENCES "public"."ChronoWalletTransactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoCreditPurchases" ADD CONSTRAINT "ChronoCreditPurchases_voidedByUserId_Users_id_fk" FOREIGN KEY ("voidedByUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoInquiries" ADD CONSTRAINT "ChronoInquiries_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoInquiries" ADD CONSTRAINT "ChronoInquiries_tenantMemberId_TenantMembers_id_fk" FOREIGN KEY ("tenantMemberId") REFERENCES "public"."TenantMembers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoInquiries" ADD CONSTRAINT "ChronoInquiries_assignedToUserId_Users_id_fk" FOREIGN KEY ("assignedToUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoInquiryMessages" ADD CONSTRAINT "ChronoInquiryMessages_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoInquiryMessages" ADD CONSTRAINT "ChronoInquiryMessages_inquiryId_ChronoInquiries_id_fk" FOREIGN KEY ("inquiryId") REFERENCES "public"."ChronoInquiries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoInquiryMessages" ADD CONSTRAINT "ChronoInquiryMessages_authorUserId_Users_id_fk" FOREIGN KEY ("authorUserId") REFERENCES "public"."Users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoInquiryMessages" ADD CONSTRAINT "ChronoInquiryMessages_authorMemberId_TenantMembers_id_fk" FOREIGN KEY ("authorMemberId") REFERENCES "public"."TenantMembers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoLandingPages" ADD CONSTRAINT "ChronoLandingPages_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoLandingPages" ADD CONSTRAINT "ChronoLandingPages_updatedByUserId_Users_id_fk" FOREIGN KEY ("updatedByUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoLoyaltyAccounts" ADD CONSTRAINT "ChronoLoyaltyAccounts_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoLoyaltyAccounts" ADD CONSTRAINT "ChronoLoyaltyAccounts_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoLoyaltyTransactions" ADD CONSTRAINT "ChronoLoyaltyTransactions_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoLoyaltyTransactions" ADD CONSTRAINT "ChronoLoyaltyTransactions_accountId_ChronoLoyaltyAccounts_id_fk" FOREIGN KEY ("accountId") REFERENCES "public"."ChronoLoyaltyAccounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoLoyaltyTransactions" ADD CONSTRAINT "ChronoLoyaltyTransactions_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoLoyaltyTransactions" ADD CONSTRAINT "ChronoLoyaltyTransactions_performedByUserId_Users_id_fk" FOREIGN KEY ("performedByUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoPromos" ADD CONSTRAINT "ChronoPromos_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoPromos" ADD CONSTRAINT "ChronoPromos_branchId_ChronoBranches_id_fk" FOREIGN KEY ("branchId") REFERENCES "public"."ChronoBranches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoPromoRedemptions" ADD CONSTRAINT "ChronoPromoRedemptions_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoPromoRedemptions" ADD CONSTRAINT "ChronoPromoRedemptions_promoId_ChronoPromos_id_fk" FOREIGN KEY ("promoId") REFERENCES "public"."ChronoPromos"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoPromoRedemptions" ADD CONSTRAINT "ChronoPromoRedemptions_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoPromoRedemptions" ADD CONSTRAINT "ChronoPromoRedemptions_saleId_ChronoSales_id_fk" FOREIGN KEY ("saleId") REFERENCES "public"."ChronoSales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoQrTokenUses" ADD CONSTRAINT "ChronoQrTokenUses_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoQrTokenUses" ADD CONSTRAINT "ChronoQrTokenUses_stationId_ChronoStations_id_fk" FOREIGN KEY ("stationId") REFERENCES "public"."ChronoStations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoQrTokenUses" ADD CONSTRAINT "ChronoQrTokenUses_consumedByMemberId_TenantMembers_id_fk" FOREIGN KEY ("consumedByMemberId") REFERENCES "public"."TenantMembers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSecurityAlerts" ADD CONSTRAINT "ChronoSecurityAlerts_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSecurityAlerts" ADD CONSTRAINT "ChronoSecurityAlerts_branchId_ChronoBranches_id_fk" FOREIGN KEY ("branchId") REFERENCES "public"."ChronoBranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSecurityAlerts" ADD CONSTRAINT "ChronoSecurityAlerts_stationId_ChronoStations_id_fk" FOREIGN KEY ("stationId") REFERENCES "public"."ChronoStations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSecurityAlerts" ADD CONSTRAINT "ChronoSecurityAlerts_reportedByUserId_Users_id_fk" FOREIGN KEY ("reportedByUserId") REFERENCES "public"."Users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSecurityAlerts" ADD CONSTRAINT "ChronoSecurityAlerts_acknowledgedByUserId_Users_id_fk" FOREIGN KEY ("acknowledgedByUserId") REFERENCES "public"."Users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSecurityAlerts" ADD CONSTRAINT "ChronoSecurityAlerts_resolvedByUserId_Users_id_fk" FOREIGN KEY ("resolvedByUserId") REFERENCES "public"."Users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSessions" ADD CONSTRAINT "ChronoSessions_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSessions" ADD CONSTRAINT "ChronoSessions_branchId_ChronoBranches_id_fk" FOREIGN KEY ("branchId") REFERENCES "public"."ChronoBranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSessions" ADD CONSTRAINT "ChronoSessions_stationId_ChronoStations_id_fk" FOREIGN KEY ("stationId") REFERENCES "public"."ChronoStations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSessions" ADD CONSTRAINT "ChronoSessions_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSessions" ADD CONSTRAINT "ChronoSessions_startedByUserId_Users_id_fk" FOREIGN KEY ("startedByUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSessions" ADD CONSTRAINT "ChronoSessions_walletTransactionId_ChronoWalletTransactions_id_fk" FOREIGN KEY ("walletTransactionId") REFERENCES "public"."ChronoWalletTransactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoVouchers" ADD CONSTRAINT "ChronoVouchers_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoVouchers" ADD CONSTRAINT "ChronoVouchers_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoVouchers" ADD CONSTRAINT "ChronoVouchers_redeemedAgainstSaleId_ChronoSales_id_fk" FOREIGN KEY ("redeemedAgainstSaleId") REFERENCES "public"."ChronoSales"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoVouchers" ADD CONSTRAINT "ChronoVouchers_issuedByUserId_Users_id_fk" FOREIGN KEY ("issuedByUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_credit_grant_tenant_idx" ON "ChronoCreditGrants" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_credit_grant_member_idx" ON "ChronoCreditGrants" USING btree ("memberId");--> statement-breakpoint
CREATE INDEX "chrono_credit_grant_station_group_idx" ON "ChronoCreditGrants" USING btree ("stationGroupId");--> statement-breakpoint
CREATE INDEX "chrono_credit_grant_status_idx" ON "ChronoCreditGrants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chrono_credit_grant_expires_idx" ON "ChronoCreditGrants" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "chrono_credit_ledger_tenant_idx" ON "ChronoCreditGrantLedgerEntries" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_credit_ledger_grant_idx" ON "ChronoCreditGrantLedgerEntries" USING btree ("grantId");--> statement-breakpoint
CREATE INDEX "chrono_credit_ledger_member_idx" ON "ChronoCreditGrantLedgerEntries" USING btree ("memberId");--> statement-breakpoint
CREATE INDEX "chrono_credit_ledger_type_idx" ON "ChronoCreditGrantLedgerEntries" USING btree ("type");--> statement-breakpoint
CREATE INDEX "chrono_credit_ledger_created_idx" ON "ChronoCreditGrantLedgerEntries" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "chrono_credit_product_tenant_idx" ON "ChronoCreditProducts" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_credit_product_tenant_code_idx" ON "ChronoCreditProducts" USING btree ("tenantId","code");--> statement-breakpoint
CREATE INDEX "chrono_credit_purchase_tenant_idx" ON "ChronoCreditPurchases" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_credit_purchase_member_idx" ON "ChronoCreditPurchases" USING btree ("memberId");--> statement-breakpoint
CREATE INDEX "chrono_credit_purchase_product_idx" ON "ChronoCreditPurchases" USING btree ("productId");--> statement-breakpoint
CREATE INDEX "chrono_credit_purchase_status_idx" ON "ChronoCreditPurchases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chrono_inquiry_tenant_idx" ON "ChronoInquiries" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_inquiry_tenant_member_idx" ON "ChronoInquiries" USING btree ("tenantMemberId");--> statement-breakpoint
CREATE INDEX "chrono_inquiry_status_idx" ON "ChronoInquiries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chrono_inquiry_assigned_idx" ON "ChronoInquiries" USING btree ("assignedToUserId");--> statement-breakpoint
CREATE INDEX "chrono_inquiry_created_idx" ON "ChronoInquiries" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "chrono_inquiry_message_tenant_idx" ON "ChronoInquiryMessages" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_inquiry_message_inquiry_idx" ON "ChronoInquiryMessages" USING btree ("inquiryId");--> statement-breakpoint
CREATE INDEX "chrono_inquiry_message_created_idx" ON "ChronoInquiryMessages" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "chrono_landing_page_tenant_idx" ON "ChronoLandingPages" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_landing_page_tenant_unique_idx" ON "ChronoLandingPages" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_loyalty_account_tenant_idx" ON "ChronoLoyaltyAccounts" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_loyalty_account_member_uq" ON "ChronoLoyaltyAccounts" USING btree ("memberId");--> statement-breakpoint
CREATE INDEX "chrono_loyalty_account_tier_idx" ON "ChronoLoyaltyAccounts" USING btree ("tier");--> statement-breakpoint
CREATE INDEX "chrono_loyalty_transaction_tenant_idx" ON "ChronoLoyaltyTransactions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_loyalty_transaction_account_idx" ON "ChronoLoyaltyTransactions" USING btree ("accountId");--> statement-breakpoint
CREATE INDEX "chrono_loyalty_transaction_member_idx" ON "ChronoLoyaltyTransactions" USING btree ("memberId");--> statement-breakpoint
CREATE INDEX "chrono_loyalty_transaction_type_idx" ON "ChronoLoyaltyTransactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "chrono_loyalty_transaction_created_idx" ON "ChronoLoyaltyTransactions" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "chrono_promo_tenant_idx" ON "ChronoPromos" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_promo_tenant_code_uq" ON "ChronoPromos" USING btree ("tenantId","code") WHERE "code" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "chrono_promo_status_idx" ON "ChronoPromos" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chrono_promo_branch_idx" ON "ChronoPromos" USING btree ("branchId");--> statement-breakpoint
CREATE INDEX "chrono_promo_window_idx" ON "ChronoPromos" USING btree ("startsAt","endsAt");--> statement-breakpoint
CREATE INDEX "chrono_promo_redemption_tenant_idx" ON "ChronoPromoRedemptions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_promo_redemption_promo_idx" ON "ChronoPromoRedemptions" USING btree ("promoId");--> statement-breakpoint
CREATE INDEX "chrono_promo_redemption_member_idx" ON "ChronoPromoRedemptions" USING btree ("memberId");--> statement-breakpoint
CREATE INDEX "chrono_qr_token_use_tenant_idx" ON "ChronoQrTokenUses" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_qr_token_use_station_idx" ON "ChronoQrTokenUses" USING btree ("stationId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_qr_token_use_nonce_idx" ON "ChronoQrTokenUses" USING btree ("nonceHash");--> statement-breakpoint
CREATE INDEX "chrono_qr_token_use_expires_idx" ON "ChronoQrTokenUses" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "chrono_security_alert_tenant_idx" ON "ChronoSecurityAlerts" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_security_alert_tenant_branch_idx" ON "ChronoSecurityAlerts" USING btree ("tenantId","branchId");--> statement-breakpoint
CREATE INDEX "chrono_security_alert_station_idx" ON "ChronoSecurityAlerts" USING btree ("stationId");--> statement-breakpoint
CREATE INDEX "chrono_security_alert_status_idx" ON "ChronoSecurityAlerts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chrono_security_alert_severity_idx" ON "ChronoSecurityAlerts" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "chrono_security_alert_created_idx" ON "ChronoSecurityAlerts" USING btree ("createdAt");--> statement-breakpoint
CREATE INDEX "chrono_session_tenant_idx" ON "ChronoSessions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_session_branch_idx" ON "ChronoSessions" USING btree ("branchId");--> statement-breakpoint
CREATE INDEX "chrono_session_station_idx" ON "ChronoSessions" USING btree ("stationId");--> statement-breakpoint
CREATE INDEX "chrono_session_member_idx" ON "ChronoSessions" USING btree ("memberId");--> statement-breakpoint
CREATE INDEX "chrono_session_status_idx" ON "ChronoSessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chrono_session_scheduled_end_idx" ON "ChronoSessions" USING btree ("scheduledEndAt");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_session_active_per_station_uq" ON "ChronoSessions" USING btree ("tenantId","stationId") WHERE "ChronoSessions"."status" in ('active','paused');--> statement-breakpoint
CREATE INDEX "chrono_voucher_tenant_idx" ON "ChronoVouchers" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_voucher_tenant_code_uq" ON "ChronoVouchers" USING btree ("tenantId","code");--> statement-breakpoint
CREATE INDEX "chrono_voucher_member_idx" ON "ChronoVouchers" USING btree ("memberId");--> statement-breakpoint
CREATE INDEX "chrono_voucher_promo_idx" ON "ChronoVouchers" USING btree ("promoId");--> statement-breakpoint
CREATE INDEX "chrono_voucher_status_idx" ON "ChronoVouchers" USING btree ("status");