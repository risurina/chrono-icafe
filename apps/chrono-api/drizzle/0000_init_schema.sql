CREATE TABLE "Accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp,
	"refreshTokenExpiresAt" timestamp,
	"scope" text,
	"password" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AnnouncementDeliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"announcementId" text NOT NULL,
	"channel" text NOT NULL,
	"recipientUserId" text,
	"organizationId" text,
	"status" text NOT NULL,
	"error" text,
	"sentAt" timestamp,
	"readAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ApiKeys" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"keyHash" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"createdBy" text,
	"lastUsedAt" timestamp,
	"revokedAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AuditEvents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"actorType" text NOT NULL,
	"actorId" text,
	"actorLabel" text,
	"action" text NOT NULL,
	"targetType" text,
	"targetId" text,
	"targetLabel" text,
	"metadata" jsonb,
	"ip" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "BillingEvents" (
	"id" text PRIMARY KEY NOT NULL,
	"eventId" text NOT NULL,
	"type" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Domains" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"hostname" text NOT NULL,
	"verificationToken" text,
	"verificationMethod" text DEFAULT 'txt' NOT NULL,
	"verifiedAt" timestamp,
	"lastCheckedAt" timestamp,
	"providerId" text,
	"isPrimary" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "FeatureDefinitions" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"globalDefault" boolean DEFAULT false NOT NULL,
	"rolloutPercentage" integer,
	"planAvailability" jsonb,
	"label" text,
	"description" text,
	"category" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"updatedBy" text
);
--> statement-breakpoint
CREATE TABLE "Invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"tokenHash" text,
	"inviterId" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"queue" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"maxAttempts" integer DEFAULT 6 NOT NULL,
	"lastError" text,
	"result" jsonb,
	"tenantId" text,
	"nextAttemptAt" timestamp DEFAULT now() NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Members" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"userId" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "NotificationTemplates" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"subject" text NOT NULL,
	"bodyHtml" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"updatedBy" text
);
--> statement-breakpoint
CREATE TABLE "Organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" text,
	"status" text DEFAULT 'active' NOT NULL,
	"suspendedAt" timestamp,
	"archivedAt" timestamp,
	"tenantType" text DEFAULT 'company' NOT NULL,
	"contactEmail" text,
	"contactPhone" text,
	"timezone" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"supportTicketRef" text,
	"supportTicketUpdatedAt" timestamp,
	CONSTRAINT "Organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "OrganizationPolicyAcceptances" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"policyType" text NOT NULL,
	"version" text NOT NULL,
	"acceptedAt" timestamp NOT NULL,
	"recordedBy" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "OrganizationRoles" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"role" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permission" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PaymentTransactions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"paymentProvider" text DEFAULT 'stripe' NOT NULL,
	"kind" text NOT NULL,
	"providerObjectId" text NOT NULL,
	"providerCustomerId" text,
	"providerInvoiceId" text,
	"amount" numeric NOT NULL,
	"refundedAmount" numeric DEFAULT '0' NOT NULL,
	"currency" text NOT NULL,
	"status" text NOT NULL,
	"method" text,
	"description" text,
	"occurredAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Plans" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"isBuiltIn" boolean DEFAULT false NOT NULL,
	"displayName" text NOT NULL,
	"description" text,
	"planType" text NOT NULL,
	"monthlyPrice" numeric DEFAULT '0' NOT NULL,
	"annualPrice" numeric DEFAULT '0' NOT NULL,
	"currency" text DEFAULT 'usd' NOT NULL,
	"trialDays" integer DEFAULT 0 NOT NULL,
	"maxUsers" integer DEFAULT 0 NOT NULL,
	"maxStorageMb" integer DEFAULT 0 NOT NULL,
	"apiRateLimitPerMin" integer DEFAULT 0 NOT NULL,
	"auditRetentionDays" integer,
	"featureAccess" jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"sortOrder" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"archivedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "PlanPrices" (
	"id" text PRIMARY KEY NOT NULL,
	"planId" text NOT NULL,
	"currency" text NOT NULL,
	"monthlyPrice" numeric DEFAULT '0' NOT NULL,
	"annualPrice" numeric DEFAULT '0' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PlatformAnnouncements" (
	"id" text PRIMARY KEY NOT NULL,
	"message" text NOT NULL,
	"type" text DEFAULT 'system' NOT NULL,
	"targeting" jsonb,
	"channels" jsonb DEFAULT '["in_app"]' NOT NULL,
	"emailSentAt" timestamp,
	"severity" text NOT NULL,
	"startsAt" timestamp DEFAULT now() NOT NULL,
	"endsAt" timestamp,
	"createdBy" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PlatformAuditEvents" (
	"id" text PRIMARY KEY NOT NULL,
	"actorId" text,
	"actorLabel" text,
	"actorRole" text,
	"action" text NOT NULL,
	"targetType" text,
	"targetId" text,
	"targetLabel" text,
	"metadata" jsonb,
	"ip" text,
	"userAgent" text,
	"result" text DEFAULT 'success' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PlatformAuthProviders" (
	"id" text PRIMARY KEY NOT NULL,
	"providerId" text NOT NULL,
	"enabled" boolean NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PlatformCustomRoles" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"permission" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "PlatformImpersonationGrants" (
	"id" text PRIMARY KEY NOT NULL,
	"actorId" text NOT NULL,
	"targetUserId" text NOT NULL,
	"targetTenantId" text NOT NULL,
	"sessionTokenHash" text,
	"startedAt" timestamp DEFAULT now() NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"endedAt" timestamp,
	"endReason" text
);
--> statement-breakpoint
CREATE TABLE "PlatformIntegrations" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"provider" text,
	"config" jsonb NOT NULL,
	"secretEnc" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"connectionStatus" text DEFAULT 'disconnected' NOT NULL,
	"lastSuccessfulConnectionAt" timestamp,
	"lastTestError" text,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"updatedBy" text
);
--> statement-breakpoint
CREATE TABLE "PlatformIntegrationAccounts" (
	"id" text PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"provider" text NOT NULL,
	"priority" integer NOT NULL,
	"label" text NOT NULL,
	"config" jsonb NOT NULL,
	"secretEnc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"connectionStatus" text DEFAULT 'disconnected' NOT NULL,
	"lastSuccessfulConnectionAt" timestamp,
	"lastTestError" text,
	"consecutiveFailures" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"updatedBy" text
);
--> statement-breakpoint
CREATE TABLE "PlatformSecurityPolicies" (
	"id" text PRIMARY KEY NOT NULL,
	"twoFactorRequired" boolean DEFAULT false NOT NULL,
	"sessionMaxAgeMinutes" integer,
	"singleton" boolean DEFAULT true NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"updatedBy" text
);
--> statement-breakpoint
CREATE TABLE "PlatformSettings" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"updatedBy" text
);
--> statement-breakpoint
CREATE TABLE "Projects" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"name" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"impersonatedBy" text,
	"userId" text NOT NULL,
	"activeOrganizationId" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "Sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "StoredFiles" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"provider" text NOT NULL,
	"storageKey" text NOT NULL,
	"feature" text,
	"visibility" text NOT NULL,
	"originalName" text NOT NULL,
	"contentType" text NOT NULL,
	"sizeBytes" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"uploadedBy" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "SupportTickets" (
	"id" text PRIMARY KEY NOT NULL,
	"organizationId" text NOT NULL,
	"subject" text NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"assignedAgentId" text,
	"requesterUserId" text,
	"requesterLabel" text,
	"createdBy" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"resolvedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "SupportTicketMessages" (
	"id" text PRIMARY KEY NOT NULL,
	"ticketId" text NOT NULL,
	"authorId" text,
	"authorLabel" text,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TenantBrandings" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"displayName" text,
	"logoUrl" text,
	"logoDarkUrl" text,
	"faviconUrl" text,
	"primaryColor" text,
	"accentColor" text,
	"theme" text DEFAULT 'system' NOT NULL,
	"tagline" text,
	"supportEmail" text,
	"emailFromName" text,
	"emailReplyTo" text,
	"emailLogoUrl" text,
	"customCss" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TenantFeatureFlags" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TenantIntegrations" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"category" text NOT NULL,
	"provider" text NOT NULL,
	"config" jsonb NOT NULL,
	"secretEnc" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TenantMembers" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"passwordHash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TenantMemberSessions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"memberId" text NOT NULL,
	"tokenHash" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TenantMemberTokens" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"memberId" text,
	"email" text NOT NULL,
	"purpose" text NOT NULL,
	"tokenHash" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TenantNotifications" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"recipientUserId" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"href" text,
	"actorUserId" text,
	"actorName" text,
	"readAt" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TenantSecurityPolicies" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"ssoRequired" boolean DEFAULT false NOT NULL,
	"mfaRequired" boolean DEFAULT false NOT NULL,
	"defaultSsoRole" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TenantSsoConnections" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"issuer" text NOT NULL,
	"clientId" text NOT NULL,
	"clientSecretEnc" text,
	"allowedDomain" text,
	"defaultRole" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TenantSubscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"paymentProvider" text DEFAULT 'stripe' NOT NULL,
	"stripeCustomerId" text,
	"stripeSubscriptionId" text,
	"currency" text,
	"plan" text NOT NULL,
	"status" text NOT NULL,
	"seats" integer NOT NULL,
	"currentPeriodEnd" timestamp,
	"manualOverride" boolean DEFAULT false NOT NULL,
	"overrideReason" text,
	"overrideBy" text,
	"overrideAt" timestamp,
	"pendingSync" jsonb,
	"previousPlan" text,
	"previousStatus" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TenantSubscriptionEvents" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"previousPlan" text,
	"newPlan" text NOT NULL,
	"previousStatus" text,
	"newStatus" text NOT NULL,
	"source" text NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TenantUsageCounters" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"resource" text NOT NULL,
	"period" text NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "TenantUsageQuotas" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"resource" text NOT NULL,
	"amount" integer NOT NULL,
	"reason" text,
	"expiresAt" timestamp,
	"createdBy" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"revokedAt" timestamp
);
--> statement-breakpoint
CREATE TABLE "TwoFactors" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backupCodes" text NOT NULL,
	"userId" text NOT NULL,
	"verified" boolean DEFAULT true,
	"failedVerificationCount" integer,
	"lockedUntil" timestamp
);
--> statement-breakpoint
CREATE TABLE "Users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"twoFactorEnabled" boolean DEFAULT false NOT NULL,
	"platformRole" text,
	"role" text,
	"banned" boolean,
	"banReason" text,
	"banExpires" timestamp,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL,
	"deletedAt" timestamp,
	CONSTRAINT "Users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "Verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "WebhookEndpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"tenantId" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"events" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"consecutiveFailures" integer DEFAULT 0 NOT NULL,
	"disabledAt" timestamp,
	"createdBy" text,
	"createdAt" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Accounts" ADD CONSTRAINT "Accounts_userId_Users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."Users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AnnouncementDeliveries" ADD CONSTRAINT "AnnouncementDeliveries_announcementId_PlatformAnnouncements_id_fk" FOREIGN KEY ("announcementId") REFERENCES "public"."PlatformAnnouncements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AnnouncementDeliveries" ADD CONSTRAINT "AnnouncementDeliveries_recipientUserId_Users_id_fk" FOREIGN KEY ("recipientUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AnnouncementDeliveries" ADD CONSTRAINT "AnnouncementDeliveries_organizationId_Organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."Organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ApiKeys" ADD CONSTRAINT "ApiKeys_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "AuditEvents" ADD CONSTRAINT "AuditEvents_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Domains" ADD CONSTRAINT "Domains_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FeatureDefinitions" ADD CONSTRAINT "FeatureDefinitions_updatedBy_Users_id_fk" FOREIGN KEY ("updatedBy") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Invitations" ADD CONSTRAINT "Invitations_organizationId_Organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Invitations" ADD CONSTRAINT "Invitations_inviterId_Users_id_fk" FOREIGN KEY ("inviterId") REFERENCES "public"."Users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Jobs" ADD CONSTRAINT "Jobs_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Members" ADD CONSTRAINT "Members_organizationId_Organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Members" ADD CONSTRAINT "Members_userId_Users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."Users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "NotificationTemplates" ADD CONSTRAINT "NotificationTemplates_updatedBy_Users_id_fk" FOREIGN KEY ("updatedBy") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OrganizationPolicyAcceptances" ADD CONSTRAINT "OrganizationPolicyAcceptances_organizationId_Organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OrganizationPolicyAcceptances" ADD CONSTRAINT "OrganizationPolicyAcceptances_recordedBy_Users_id_fk" FOREIGN KEY ("recordedBy") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "OrganizationRoles" ADD CONSTRAINT "OrganizationRoles_organizationId_Organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PaymentTransactions" ADD CONSTRAINT "PaymentTransactions_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PlanPrices" ADD CONSTRAINT "PlanPrices_planId_Plans_id_fk" FOREIGN KEY ("planId") REFERENCES "public"."Plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PlatformAnnouncements" ADD CONSTRAINT "PlatformAnnouncements_createdBy_Users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PlatformAuditEvents" ADD CONSTRAINT "PlatformAuditEvents_actorId_Users_id_fk" FOREIGN KEY ("actorId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PlatformImpersonationGrants" ADD CONSTRAINT "PlatformImpersonationGrants_actorId_Users_id_fk" FOREIGN KEY ("actorId") REFERENCES "public"."Users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PlatformImpersonationGrants" ADD CONSTRAINT "PlatformImpersonationGrants_targetUserId_Users_id_fk" FOREIGN KEY ("targetUserId") REFERENCES "public"."Users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PlatformImpersonationGrants" ADD CONSTRAINT "PlatformImpersonationGrants_targetTenantId_Organizations_id_fk" FOREIGN KEY ("targetTenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PlatformIntegrations" ADD CONSTRAINT "PlatformIntegrations_updatedBy_Users_id_fk" FOREIGN KEY ("updatedBy") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PlatformIntegrationAccounts" ADD CONSTRAINT "PlatformIntegrationAccounts_updatedBy_Users_id_fk" FOREIGN KEY ("updatedBy") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PlatformSecurityPolicies" ADD CONSTRAINT "PlatformSecurityPolicies_updatedBy_Users_id_fk" FOREIGN KEY ("updatedBy") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PlatformSettings" ADD CONSTRAINT "PlatformSettings_updatedBy_Users_id_fk" FOREIGN KEY ("updatedBy") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Projects" ADD CONSTRAINT "Projects_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Sessions" ADD CONSTRAINT "Sessions_userId_Users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."Users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "StoredFiles" ADD CONSTRAINT "StoredFiles_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "StoredFiles" ADD CONSTRAINT "StoredFiles_uploadedBy_Users_id_fk" FOREIGN KEY ("uploadedBy") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SupportTickets" ADD CONSTRAINT "SupportTickets_organizationId_Organizations_id_fk" FOREIGN KEY ("organizationId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SupportTickets" ADD CONSTRAINT "SupportTickets_assignedAgentId_Users_id_fk" FOREIGN KEY ("assignedAgentId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SupportTickets" ADD CONSTRAINT "SupportTickets_requesterUserId_Users_id_fk" FOREIGN KEY ("requesterUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SupportTickets" ADD CONSTRAINT "SupportTickets_createdBy_Users_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SupportTicketMessages" ADD CONSTRAINT "SupportTicketMessages_ticketId_SupportTickets_id_fk" FOREIGN KEY ("ticketId") REFERENCES "public"."SupportTickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SupportTicketMessages" ADD CONSTRAINT "SupportTicketMessages_authorId_Users_id_fk" FOREIGN KEY ("authorId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantBrandings" ADD CONSTRAINT "TenantBrandings_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantFeatureFlags" ADD CONSTRAINT "TenantFeatureFlags_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantIntegrations" ADD CONSTRAINT "TenantIntegrations_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantMembers" ADD CONSTRAINT "TenantMembers_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantMemberSessions" ADD CONSTRAINT "TenantMemberSessions_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantMemberSessions" ADD CONSTRAINT "TenantMemberSessions_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantMemberTokens" ADD CONSTRAINT "TenantMemberTokens_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantMemberTokens" ADD CONSTRAINT "TenantMemberTokens_memberId_TenantMembers_id_fk" FOREIGN KEY ("memberId") REFERENCES "public"."TenantMembers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantNotifications" ADD CONSTRAINT "TenantNotifications_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantNotifications" ADD CONSTRAINT "TenantNotifications_recipientUserId_Users_id_fk" FOREIGN KEY ("recipientUserId") REFERENCES "public"."Users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantNotifications" ADD CONSTRAINT "TenantNotifications_actorUserId_Users_id_fk" FOREIGN KEY ("actorUserId") REFERENCES "public"."Users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantSecurityPolicies" ADD CONSTRAINT "TenantSecurityPolicies_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantSsoConnections" ADD CONSTRAINT "TenantSsoConnections_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantSubscriptions" ADD CONSTRAINT "TenantSubscriptions_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantSubscriptionEvents" ADD CONSTRAINT "TenantSubscriptionEvents_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantUsageCounters" ADD CONSTRAINT "TenantUsageCounters_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TenantUsageQuotas" ADD CONSTRAINT "TenantUsageQuotas_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TwoFactors" ADD CONSTRAINT "TwoFactors_userId_Users_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."Users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "WebhookEndpoints" ADD CONSTRAINT "WebhookEndpoints_tenantId_Organizations_id_fk" FOREIGN KEY ("tenantId") REFERENCES "public"."Organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcement_delivery_ann_channel_idx" ON "AnnouncementDeliveries" USING btree ("announcementId","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "announcement_delivery_ann_user_channel_uq" ON "AnnouncementDeliveries" USING btree ("announcementId","recipientUserId","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "api_key_prefix_uq" ON "ApiKeys" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "api_key_tenant_idx" ON "ApiKeys" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "audit_event_tenant_idx" ON "AuditEvents" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "audit_event_tenant_created_idx" ON "AuditEvents" USING btree ("tenantId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_event_event_id_uq" ON "BillingEvents" USING btree ("eventId");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_hostname_uq" ON "Domains" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "domain_tenant_idx" ON "Domains" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "feature_definition_key_uq" ON "FeatureDefinitions" USING btree ("key");--> statement-breakpoint
CREATE INDEX "job_due_idx" ON "Jobs" USING btree ("queue","status","nextAttemptAt");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_template_key_uq" ON "NotificationTemplates" USING btree ("key");--> statement-breakpoint
CREATE INDEX "organization_policy_acceptance_org_type_accepted_idx" ON "OrganizationPolicyAcceptances" USING btree ("organizationId","policyType","acceptedAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "organization_role_org_key_idx" ON "OrganizationRoles" USING btree ("organizationId","role");--> statement-breakpoint
CREATE INDEX "organization_role_org_idx" ON "OrganizationRoles" USING btree ("organizationId");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transaction_provider_obj_uq" ON "PaymentTransactions" USING btree ("paymentProvider","providerObjectId");--> statement-breakpoint
CREATE INDEX "payment_transaction_tenant_idx" ON "PaymentTransactions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "payment_transaction_occurred_idx" ON "PaymentTransactions" USING btree ("occurredAt");--> statement-breakpoint
CREATE INDEX "payment_transaction_tenant_occurred_idx" ON "PaymentTransactions" USING btree ("tenantId","occurredAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "plan_key_uq" ON "Plans" USING btree ("key");--> statement-breakpoint
CREATE INDEX "plan_status_sort_idx" ON "Plans" USING btree ("status","sortOrder");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_price_plan_currency_uq" ON "PlanPrices" USING btree ("planId","currency");--> statement-breakpoint
CREATE INDEX "platform_announcement_active_idx" ON "PlatformAnnouncements" USING btree ("startsAt","endsAt");--> statement-breakpoint
CREATE INDEX "platform_announcement_created_idx" ON "PlatformAnnouncements" USING btree ("createdAt" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "platform_audit_event_created_id_idx" ON "PlatformAuditEvents" USING btree ("createdAt" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "platform_audit_event_target_idx" ON "PlatformAuditEvents" USING btree ("targetType","targetId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "platform_audit_event_target_action_created_idx" ON "PlatformAuditEvents" USING btree ("targetType","targetId","action","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "platform_auth_provider_provider_uq" ON "PlatformAuthProviders" USING btree ("providerId");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_custom_role_key_idx" ON "PlatformCustomRoles" USING btree ("key");--> statement-breakpoint
CREATE INDEX "platform_impersonation_grant_actor_idx" ON "PlatformImpersonationGrants" USING btree ("actorId","endedAt");--> statement-breakpoint
CREATE INDEX "platform_impersonation_grant_target_idx" ON "PlatformImpersonationGrants" USING btree ("targetUserId");--> statement-breakpoint
CREATE INDEX "platform_impersonation_grant_target_tenant_idx" ON "PlatformImpersonationGrants" USING btree ("targetTenantId","startedAt" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "platform_impersonation_grant_one_active_idx" ON "PlatformImpersonationGrants" USING btree ("actorId") WHERE "endedAt" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_integration_category_uq" ON "PlatformIntegrations" USING btree ("category");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_integration_account_category_priority_uq" ON "PlatformIntegrationAccounts" USING btree ("category","priority");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_security_policy_singleton_uq" ON "PlatformSecurityPolicies" USING btree ("singleton");--> statement-breakpoint
CREATE UNIQUE INDEX "platform_setting_key_uq" ON "PlatformSettings" USING btree ("key");--> statement-breakpoint
CREATE INDEX "project_tenant_idx" ON "Projects" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "Sessions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "stored_file_tenant_idx" ON "StoredFiles" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "support_ticket_queue_idx" ON "SupportTickets" USING btree ("status","priority","updatedAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_ticket_org_idx" ON "SupportTickets" USING btree ("organizationId","createdAt" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "support_ticket_agent_idx" ON "SupportTickets" USING btree ("assignedAgentId");--> statement-breakpoint
CREATE INDEX "support_ticket_message_ticket_idx" ON "SupportTicketMessages" USING btree ("ticketId","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_branding_tenant_uq" ON "TenantBrandings" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "tenant_branding_tenant_idx" ON "TenantBrandings" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_feature_flag_tenant_key_uq" ON "TenantFeatureFlags" USING btree ("tenantId","key");--> statement-breakpoint
CREATE INDEX "tenant_feature_flag_tenant_idx" ON "TenantFeatureFlags" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_integration_tenant_category_uq" ON "TenantIntegrations" USING btree ("tenantId","category");--> statement-breakpoint
CREATE INDEX "tenant_integration_tenant_idx" ON "TenantIntegrations" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_member_email_uq" ON "TenantMembers" USING btree ("tenantId","email");--> statement-breakpoint
CREATE INDEX "tenant_member_tenant_idx" ON "TenantMembers" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_member_session_token_uq" ON "TenantMemberSessions" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "tenant_member_session_tenant_idx" ON "TenantMemberSessions" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_member_token_token_uq" ON "TenantMemberTokens" USING btree ("tokenHash");--> statement-breakpoint
CREATE INDEX "tenant_member_token_tenant_idx" ON "TenantMemberTokens" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "tenant_notification_tenant_idx" ON "TenantNotifications" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "tenant_notification_recipient_idx" ON "TenantNotifications" USING btree ("recipientUserId");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_security_policy_tenant_uq" ON "TenantSecurityPolicies" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "tenant_security_policy_tenant_idx" ON "TenantSecurityPolicies" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_sso_connection_tenant_uq" ON "TenantSsoConnections" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "tenant_sso_connection_tenant_idx" ON "TenantSsoConnections" USING btree ("tenantId");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_subscription_tenant_uq" ON "TenantSubscriptions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "tenant_subscription_tenant_idx" ON "TenantSubscriptions" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "tenant_subscription_customer_idx" ON "TenantSubscriptions" USING btree ("stripeCustomerId");--> statement-breakpoint
CREATE INDEX "tenant_subscription_event_tenant_idx" ON "TenantSubscriptionEvents" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "tenant_subscription_event_created_idx" ON "TenantSubscriptionEvents" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_usage_counter_key" ON "TenantUsageCounters" USING btree ("tenantId","resource","period");--> statement-breakpoint
CREATE INDEX "tenant_usage_counter_tenant_idx" ON "TenantUsageCounters" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "tenant_usage_quota_tenant_idx" ON "TenantUsageQuotas" USING btree ("tenantId");--> statement-breakpoint
CREATE INDEX "webhook_endpoint_tenant_idx" ON "WebhookEndpoints" USING btree ("tenantId");