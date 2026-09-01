CREATE TABLE "ChronoWallets" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"memberId" text NOT NULL,
	"balance" numeric(12, 2) DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'PHP' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoWalletTransactions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"walletId" text NOT NULL,
	"memberId" text NOT NULL,
	"type" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"balanceBefore" numeric(12, 2) NOT NULL,
	"balanceAfter" numeric(12, 2) NOT NULL,
	"reason" text NOT NULL,
	"referenceType" text,
	"referenceId" text,
	"performedByUserId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChronoWallets" ADD CONSTRAINT "ChronoWallets_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoWallets" ADD CONSTRAINT "ChronoWallets_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoWalletTransactions" ADD CONSTRAINT "ChronoWalletTransactions_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoWalletTransactions" ADD CONSTRAINT "ChronoWalletTransactions_walletId_ChronoWallets_id_fk" FOREIGN KEY ("walletId") REFERENCES "public"."ChronoWallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoWalletTransactions" ADD CONSTRAINT "ChronoWalletTransactions_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoWalletTransactions" ADD CONSTRAINT "ChronoWalletTransactions_performedByUserId_Users_id_fk" FOREIGN KEY ("performedByUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_wallet_tenant_idx" ON "ChronoWallets" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_wallet_member_uq" ON "ChronoWallets" USING btree ("memberId");--> statement-breakpoint
CREATE INDEX "chrono_wallet_transaction_tenant_idx" ON "ChronoWalletTransactions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_wallet_transaction_wallet_idx" ON "ChronoWalletTransactions" USING btree ("walletId");--> statement-breakpoint
CREATE INDEX "chrono_wallet_transaction_member_idx" ON "ChronoWalletTransactions" USING btree ("memberId");--> statement-breakpoint
CREATE INDEX "chrono_wallet_transaction_type_idx" ON "ChronoWalletTransactions" USING btree ("type");--> statement-breakpoint
CREATE INDEX "chrono_wallet_transaction_created_idx" ON "ChronoWalletTransactions" USING btree ("createdAt");