CREATE TABLE "ChronoProducts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"name" text NOT NULL,
	"sku" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"price" numeric(12, 2) NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"trackStock" boolean DEFAULT false NOT NULL,
	"stockQuantity" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoSales" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"branchId" text NOT NULL,
	"shiftId" text,
	"memberId" text,
	"customerName" text,
	"cashierUserId" text NOT NULL,
	"status" text DEFAULT 'completed' NOT NULL,
	"totalAmount" numeric(12, 2) NOT NULL,
	"amountTendered" numeric(12, 2) NOT NULL,
	"changeAmount" numeric(12, 2) NOT NULL,
	"idempotencyKey" text NOT NULL,
	"refundedAt" timestamp,
	"refundedByUserId" text,
	"refundReason" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoSaleItems" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"saleId" text NOT NULL,
	"productId" text,
	"name" text NOT NULL,
	"sku" text,
	"unitPrice" numeric(12, 2) NOT NULL,
	"quantity" integer NOT NULL,
	"lineTotal" numeric(12, 2) NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ChronoSalePayments" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"saleId" text NOT NULL,
	"method" text NOT NULL,
	"amount" numeric(12, 2) NOT NULL,
	"referenceNumber" text,
	"walletTransactionId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ChronoProducts" ADD CONSTRAINT "ChronoProducts_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSales" ADD CONSTRAINT "ChronoSales_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSales" ADD CONSTRAINT "ChronoSales_branchId_ChronoBranches_id_fk" FOREIGN KEY ("branchId") REFERENCES "public"."ChronoBranches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSales" ADD CONSTRAINT "ChronoSales_shiftId_ChronoShifts_id_fk" FOREIGN KEY ("shiftId") REFERENCES "public"."ChronoShifts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSales" ADD CONSTRAINT "ChronoSales_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSales" ADD CONSTRAINT "ChronoSales_cashierUserId_Users_id_fk" FOREIGN KEY ("cashierUserId") REFERENCES "public"."Users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSales" ADD CONSTRAINT "ChronoSales_refundedByUserId_Users_id_fk" FOREIGN KEY ("refundedByUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSaleItems" ADD CONSTRAINT "ChronoSaleItems_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSaleItems" ADD CONSTRAINT "ChronoSaleItems_saleId_ChronoSales_id_fk" FOREIGN KEY ("saleId") REFERENCES "public"."ChronoSales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSaleItems" ADD CONSTRAINT "ChronoSaleItems_productId_ChronoProducts_id_fk" FOREIGN KEY ("productId") REFERENCES "public"."ChronoProducts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSalePayments" ADD CONSTRAINT "ChronoSalePayments_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ChronoSalePayments" ADD CONSTRAINT "ChronoSalePayments_saleId_ChronoSales_id_fk" FOREIGN KEY ("saleId") REFERENCES "public"."ChronoSales"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chrono_product_tenant_idx" ON "ChronoProducts" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_product_tenant_sku_idx" ON "ChronoProducts" USING btree ("tenantId","sku");--> statement-breakpoint
CREATE INDEX "chrono_product_status_idx" ON "ChronoProducts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chrono_sale_tenant_idx" ON "ChronoSales" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_sale_tenant_branch_idx" ON "ChronoSales" USING btree ("tenantId","branchId");--> statement-breakpoint
CREATE INDEX "chrono_sale_shift_idx" ON "ChronoSales" USING btree ("shiftId");--> statement-breakpoint
CREATE INDEX "chrono_sale_member_idx" ON "ChronoSales" USING btree ("memberId");--> statement-breakpoint
CREATE INDEX "chrono_sale_status_idx" ON "ChronoSales" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chrono_sale_created_idx" ON "ChronoSales" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "chrono_sale_tenant_idempotency_idx" ON "ChronoSales" USING btree ("tenantId","idempotencyKey");--> statement-breakpoint
CREATE INDEX "chrono_sale_item_tenant_idx" ON "ChronoSaleItems" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_sale_item_sale_idx" ON "ChronoSaleItems" USING btree ("saleId");--> statement-breakpoint
CREATE INDEX "chrono_sale_item_product_idx" ON "ChronoSaleItems" USING btree ("productId");--> statement-breakpoint
CREATE INDEX "chrono_sale_payment_tenant_idx" ON "ChronoSalePayments" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "chrono_sale_payment_sale_idx" ON "ChronoSalePayments" USING btree ("saleId");--> statement-breakpoint
CREATE INDEX "chrono_sale_payment_method_idx" ON "ChronoSalePayments" USING btree ("method");