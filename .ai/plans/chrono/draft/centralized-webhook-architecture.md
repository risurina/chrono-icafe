# Chrono Centralized Webhook Architecture

## Status
Draft

## Goal

Create one centralized webhook architecture for Chrono so integrations do **not** create spaghetti webhook URLs or provider-specific routes scattered throughout the application.

The architecture must support:

- Platform-owned integrations.
- Per-tenant integrations.
- Payment providers in particular.
- Multiple providers (PayMongo, Maya, Paddle, future PSPs, messaging, identity, etc.).
- Provider-specific signature verification without leaking provider logic into business services.
- Idempotent processing and safe retries.
- Clear tenant isolation.
- A canonical internal event model independent of provider payloads.

## Current repository context

The repository is a monorepo containing `apps/chrono-api`, `apps/chrono-web`, `apps/chrono-docs`, and other Agora applications. The Chrono API is therefore the correct application boundary for inbound provider webhooks. Do not introduce webhook endpoints into the web application or create provider-specific endpoints across unrelated modules.

## Core decision

Use **one webhook ingress pattern** in `chrono-api`:

```text
POST /api/v1/webhooks/{provider}
```

Examples:

```text
POST /api/v1/webhooks/paymongo
POST /api/v1/webhooks/maya
POST /api/v1/webhooks/paddle
POST /api/v1/webhooks/{future-provider}
```

These are provider-level ingress endpoints, not tenant-level endpoints.

Do **NOT** create routes such as:

```text
/api/webhooks/{tenantId}/paymongo
/api/webhooks/{tenantId}/maya
/api/tenants/{tenantId}/payments/webhook
/api/webhooks/paymongo/{tenantId}
```

The external URL must remain stable as tenants are created, migrated, suspended, or deleted.

The tenant is resolved internally from the integration/account context and/or trusted payment metadata. The URL must never be the security boundary for tenant identification.

---

# 1. High-level architecture

```text
                    EXTERNAL PROVIDERS
       ┌──────────────┬──────────────┬──────────────┐
       │   PayMongo   │     Maya     │    Paddle    │
       └──────┬───────┴──────┬───────┴──────┬───────┘
              │               │              │
              └───────────────┼──────────────┘
                              ▼
                 ┌─────────────────────────┐
                 │ Central Webhook Ingress │
                 │ /api/v1/webhooks/:prov │
                 └────────────┬────────────┘
                              ▼
                 ┌─────────────────────────┐
                 │ Provider Adapter Layer  │
                 │ - verify signature      │
                 │ - parse payload         │
                 │ - normalize event       │
                 └────────────┬────────────┘
                              ▼
                 ┌─────────────────────────┐
                 │ Integration Resolver    │
                 │ - provider account      │
                 │ - platform vs tenant    │
                 │ - tenant_id             │
                 │ - integration_id        │
                 └────────────┬────────────┘
                              ▼
                 ┌─────────────────────────┐
                 │ Webhook Event Store     │
                 │ idempotency + audit     │
                 └────────────┬────────────┘
                              ▼
                 ┌─────────────────────────┐
                 │ Internal Event Router   │
                 └────────────┬────────────┘
                              ▼
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   Payments Domain       Wallet Domain        Billing Domain
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
                    Tenant / Member state
```

The important separation is:

**Ingress != Provider adapter != Tenant resolution != Business processing.**

This prevents webhook code from becoming a collection of provider-specific business rules.

---

# 2. Platform vs tenant webhook model

Chrono should have two logical scopes, but **not two different URL systems**.

## Platform scope

A platform integration belongs to Chrono itself.

Examples:

- Chrono's own Paddle billing account.
- Chrono's own email provider.
- Chrono's own operational integrations.
- A provider account used only for Chrono SaaS billing.

The webhook is resolved as:

```text
scope = platform
tenant_id = null
integration_id = <platform integration>
```

## Tenant scope

A tenant integration belongs to one Chrono tenant.

Examples:

- Tenant A connects its PayMongo account.
- Tenant B connects its Maya account.
- Tenant C connects its own future PSP account.

The same external endpoint is used:

```text
POST /api/v1/webhooks/paymongo
```

The resolver determines:

```text
scope = tenant
tenant_id = tenant_A
integration_id = tenant_A_paymongo
provider_account_id = <provider account>
```

### Critical rule

Never accept `tenant_id` from the webhook URL as proof of tenant ownership.

Never trust an arbitrary `tenant_id` supplied in an unverified payload.

Tenant context must be derived from a trusted provider identity, a previously registered integration/account mapping, or verified payment metadata/reference created by Chrono.

---

# 3. Payment architecture

Payments are the most important case because a payment webhook can change money-related state.

The preferred flow is:

```text
Member starts top-up / payment
          │
          ▼
Chrono Payment Service
          │
          ├── tenant_id
          ├── member_id
          ├── payment_intent_id
          ├── integration_id
          └── provider metadata/reference
          │
          ▼
Payment Provider
          │
          │ webhook
          ▼
/api/v1/webhooks/{provider}
          │
          ▼
Verify + normalize + resolve integration
          │
          ▼
Canonical payment event
          │
          ▼
Payment domain
          │
          ├── mark payment succeeded/failed
          ├── ledger transaction
          ├── wallet credit/debit where applicable
          └── notifications / downstream events
```

The browser/mobile client must **never** be the authority for final payment success.

For example, the client may return from a checkout page saying `success`, but Chrono should only credit the wallet after a trusted provider event or a server-side provider verification confirms the payment.

---

# 4. Provider adapter contract

Each provider should implement the same internal interface.

Conceptually:

```ts
interface WebhookProviderAdapter {
  verifySignature(input: {
    rawBody: string | Buffer;
    headers: Record<string, string | string[] | undefined>;
    integration: IntegrationContext;
  }): Promise<void>;

  parseEvent(input: {
    rawBody: string | Buffer;
    headers: Record<string, string | string[] | undefined>;
  }): ProviderWebhookEvent;

  resolveProviderAccount(event: ProviderWebhookEvent): string | null;

  normalizeEvent(event: ProviderWebhookEvent): CanonicalWebhookEvent;
}
```

Provider code should only understand provider-specific concepts.

It should NOT directly:

- modify wallet balances;
- modify tenant records;
- create ledger entries;
- activate rentals;
- send business notifications;
- decide whether a payment is economically valid.

Those belong to Chrono domain services.

---

# 5. Canonical webhook event

After verification and provider parsing, convert every webhook into a canonical internal event.

Example:

```ts
interface CanonicalWebhookEvent {
  id: string;
  provider: string;
  providerEventId: string;
  providerAccountId: string | null;

  scope: 'platform' | 'tenant';
  tenantId: string | null;
  integrationId: string;

  category:
    | 'payment'
    | 'refund'
    | 'payout'
    | 'subscription'
    | 'invoice'
    | 'identity'
    | 'communication'
    | 'other';

  type: string;
  occurredAt: string;

  resourceType: string | null;
  resourceId: string | null;

  payload: unknown;
  rawPayloadRef: string | null;
}
```

Business services consume this canonical event rather than provider-specific webhook JSON.

This makes adding another PSP much cheaper.

---

# 6. Integration registry

Create a central integration registry/configuration model rather than hard-coding provider secrets throughout the application.

Conceptual data model:

```text
integrations
-------------
id
scope                  platform | tenant
tenant_id              nullable
provider               paymongo | maya | paddle | ...
provider_account_id    nullable
status                 active | disabled | disconnected
credentials_ref        secret reference only
configuration          json/jsonb
created_at
updated_at
```

Recommended uniqueness rules:

```text
(scope, tenant_id, provider, provider_account_id)
```

with appropriate handling for platform records.

Do not store raw provider secret keys in webhook events.

Do not put provider secrets into URLs.

---

# 7. How tenant resolution works

Use the strongest available identifier in this order:

### A. Provider account identity

Best option when the tenant owns the provider account.

```text
provider = paymongo
provider_account_id = acct_xxx
                 │
                 ▼
integrations.provider_account_id
                 │
                 ▼
tenant_id = tenant_123
```

### B. Verified Chrono payment reference / metadata

For shared platform provider accounts, the payment created by Chrono must contain an immutable Chrono reference that maps back to the tenant.

Example:

```text
chrono_payment_id = cp_01...
tenant_id = tenant_123
member_id = member_456
```

The webhook resolver looks up the Chrono payment using the provider resource ID/reference.

### C. Provider-side resource lookup

If a provider event does not include enough information, the provider adapter may retrieve the authoritative resource using the configured server-side credentials.

### D. Unresolved event

If tenant resolution is impossible, do **not guess**.

Persist the event as:

```text
scope = unresolved
processing_status = needs_resolution
```

and alert/queue it for investigation.

A money event must never be assigned to an arbitrary tenant because a guessed identifier happens to match.

---

# 8. Webhook ingestion lifecycle

The HTTP endpoint should be intentionally thin.

```text
1. Receive request
2. Capture raw body
3. Identify provider
4. Load candidate integration configuration
5. Verify provider signature
6. Parse provider event
7. Resolve provider account / integration
8. Resolve platform vs tenant scope
9. Calculate idempotency key
10. Persist inbound webhook
11. Return provider acknowledgement quickly
12. Process asynchronously
```

The endpoint should not perform long-running payment processing before acknowledging the provider.

---

# 9. Idempotency

Provider webhooks can be delivered multiple times.

Create a unique key such as:

```text
(provider, provider_event_id)
```

or, where necessary:

```text
(provider, provider_account_id, provider_event_id)
```

Database uniqueness should enforce this. Application-level `if (!exists)` checks alone are insufficient under concurrency.

Processing states should distinguish:

```text
received
processing
processed
failed
needs_resolution
ignored
```

A duplicate event should be acknowledged safely without applying the financial side effect twice.

---

# 10. Payment idempotency is separate from webhook idempotency

This distinction is important.

A webhook can be unique while the resulting business operation still needs protection.

For example:

```text
provider event
      ↓
payment update
      ↓
ledger transaction
      ↓
wallet credit
```

The wallet credit must have its own durable idempotency/reference constraint tied to the Chrono payment/ledger operation.

Never rely only on `webhook_events.provider_event_id` to protect a wallet balance.

Use a ledger-first model where possible:

```text
payment -> ledger entry -> wallet balance projection
```

with a unique business reference for the financial transaction.

---

# 11. Recommended database entities

Names can be adapted to existing Chrono schema conventions, but the conceptual separation should remain.

## `integrations`

Stores platform and tenant provider connections.

## `webhook_events`

Stores the inbound provider event and processing state.

Suggested fields:

```text
id
provider
provider_event_id
provider_account_id
integration_id
scope
tenant_id
event_type
resource_type
resource_id
signature_verified
processing_status
attempt_count
first_received_at
last_received_at
processed_at
last_error
payload_hash
raw_payload_ref
created_at
updated_at
```

Avoid exposing raw sensitive payloads unnecessarily.

## `payment_transactions`

Chrono's canonical payment record.

## `ledger_entries`

Immutable money movements.

## `wallets` / wallet projection

Current spendable balance derived from the ledger model.

The exact existing schema should be reused where possible instead of introducing duplicate financial models.

---

# 12. Platform and tenant processing example

## Platform Paddle billing

```text
Paddle
  ↓
/api/v1/webhooks/paddle
  ↓
verify
  ↓
provider account = Chrono platform account
  ↓
scope = platform
  ↓
subscription/invoice domain
```

No tenant is involved.

## Tenant A PayMongo

```text
Tenant A PayMongo account
  ↓
/api/v1/webhooks/paymongo
  ↓
verify
  ↓
provider account = acct_A
  ↓
integrations lookup
  ↓
tenant_id = Tenant A
  ↓
canonical payment event
  ↓
Tenant A payment / wallet / ledger
```

## Tenant B PayMongo

Exactly the same URL:

```text
Tenant B PayMongo account
  ↓
/api/v1/webhooks/paymongo
  ↓
verify
  ↓
provider account = acct_B
  ↓
integrations lookup
  ↓
tenant_id = Tenant B
```

There is no Tenant B webhook route.

---

# 13. Shared provider account case

If Chrono temporarily operates a shared provider account for multiple tenants, the design must still avoid tenant-specific URLs.

Example:

```text
PayMongo shared Chrono account
          │
          ├── payment A metadata → chrono_payment_A
          ├── payment B metadata → chrono_payment_B
          └── payment C metadata → chrono_payment_C
```

Each Chrono payment must have an immutable internal reference that can resolve:

```text
chrono_payment_id
→ tenant_id
→ member_id
→ integration_id
```

Do not use email address, amount, description, or other ambiguous fields to infer ownership.

---

# 14. Security requirements

Webhook security should be treated as a payment-security boundary.

Required:

- Preserve the exact raw request body for signature verification.
- Verify provider signatures before trusting payload content.
- Use provider-specific signature implementations inside adapters.
- Reject invalid signatures.
- Enforce timestamp/replay protections when the provider supports them.
- Apply request size limits.
- Rate-limit where appropriate without breaking legitimate provider retries.
- Never log secrets or authorization headers.
- Redact payment/customer sensitive fields in logs.
- Never allow tenant ID from the URL to determine authorization.
- Never allow an unverified payload to select an integration secret.
- Never mutate financial state before verification and idempotency checks.

The resolver must also ensure that a provider account can only map to the integration that owns that account.

---

# 15. Do not dynamically select secrets from arbitrary request fields

A dangerous anti-pattern is:

```ts
const tenantId = req.body.tenant_id;
const secret = getSecretForTenant(tenantId);
verify(req, secret);
```

This creates an attacker-controlled secret-selection mechanism.

Instead:

```text
provider
   ↓
trusted provider verification strategy
   ↓
registered integration/account candidates
   ↓
verify signature
   ↓
resolve exact integration
```

If a provider's signature scheme requires an account-specific secret, the candidate account must be identified from a trusted provider-level identifier or a safe registration mechanism—not from an untrusted tenant ID.

---

# 16. Internal event routing

After persistence, route canonical events by domain:

```text
CanonicalWebhookEvent
        │
        ├── payment.*       → PaymentService
        ├── refund.*        → PaymentService
        ├── subscription.*  → BillingService
        ├── payout.*        → PayoutService
        └── identity.*      → IdentityService
```

Provider adapters should never import wallet/rental/business modules directly.

This keeps dependency direction clean:

```text
provider adapter
      ↓
canonical event
      ↓
domain service
```

not:

```text
PayMongo webhook
  ↓
wallet service
  ↓
rental service
  ↓
email service
  ↓
random tenant controller
```

---

# 17. Outbound webhooks are a separate concern

If Chrono eventually allows tenants to receive webhooks from Chrono, use a separate outbound system.

Do not confuse:

```text
Inbound provider webhooks
```

with:

```text
Chrono outbound tenant webhooks
```

Recommended future pattern:

```text
Chrono domain event
      ↓
Outbound Event Dispatcher
      ↓
Tenant webhook subscription
      ↓
Tenant's URL
```

This is the one place where tenant-specific URLs are appropriate because the tenant is the receiver.

Example subscription:

```text
webhook_subscriptions
----------------------
tenant_id
endpoint_url
secret
subscribed_events
status
```

The inbound payment provider URL and outbound tenant webhook URL must remain conceptually and operationally separate.

---

# 18. Suggested code organization

The exact existing folder conventions must be inspected before implementation, but the architecture should converge toward something similar to:

```text
apps/chrono-api/src/
  integrations/
    webhook/
      ingress/
        webhook.controller.ts
        webhook.service.ts
      adapters/
        paymongo/
          paymongo.webhook.ts
          paymongo.adapter.ts
        maya/
          maya.webhook.ts
          maya.adapter.ts
        paddle/
          paddle.webhook.ts
          paddle.adapter.ts
      resolver/
        integration-resolver.ts
      events/
        canonical-webhook-event.ts
      processing/
        webhook-processor.ts

  domains/
    payments/
    wallet/
    billing/
    ledger/
```

Do not mechanically create this exact structure if the current Chrono API already has an established module convention. Adapt the architecture to existing conventions.

---

# 19. Provider registration

Use a registry rather than a growing controller switch statement.

Conceptually:

```ts
const webhookProviders = new Map([
  ['paymongo', paymongoWebhookAdapter],
  ['maya', mayaWebhookAdapter],
  ['paddle', paddleWebhookAdapter],
]);
```

The ingress controller becomes generic:

```text
/webhooks/:provider
       ↓
provider registry
       ↓
adapter
```

Adding a new provider should normally require:

1. New adapter.
2. Provider configuration.
3. Integration registration.
4. Provider-specific tests.

It should NOT require a new tenant route or changes to the payment domain.

---

# 20. Observability

Every webhook should carry a correlation chain:

```text
webhook_event_id
      ↓
provider_event_id
      ↓
integration_id
      ↓
tenant_id
      ↓
payment_transaction_id
      ↓
ledger_entry_id
```

This makes it possible to answer:

> "Why did Tenant X's wallet change?"

without searching through provider-specific logs.

Recommended operational views:

- Webhook received.
- Signature verification result.
- Integration resolved.
- Tenant resolved.
- Event processing status.
- Retry count.
- Last processing error.
- Financial transaction reference.

---

# 21. Failure handling

Provider delivery should be acknowledged only after the event has been safely persisted, not after all business processing completes.

Recommended pattern:

```text
HTTP request
   ↓
verify
   ↓
persist webhook event
   ↓
HTTP 2xx
   ↓
async processor
   ↓
retry with backoff
```

If processing fails:

```text
webhook_events.processing_status = failed
attempt_count += 1
last_error = sanitized error
```

Retryable failures should be retried.

Permanent failures should be moved to a dead-letter/manual-review state.

Payment events requiring tenant resolution should use `needs_resolution`, not generic `failed`.

---

# 22. Testing strategy

Every provider adapter must have tests for:

### Signature

- Valid signature accepted.
- Invalid signature rejected.
- Modified body rejected.
- Missing signature rejected where required.
- Replay protection where supported.

### Routing

- Platform integration resolves to platform scope.
- Tenant A resolves to Tenant A.
- Tenant B resolves to Tenant B.
- Unknown provider account is not assigned to a tenant.
- Cross-tenant provider account mapping is rejected.

### Idempotency

- Same provider event delivered twice results in one business effect.
- Concurrent duplicate delivery remains safe.

### Payments

- Successful payment credits exactly once.
- Failed payment does not credit wallet.
- Refund creates the correct compensating financial event.
- Out-of-order provider events do not corrupt final payment state.

### Security

- Tenant ID in payload cannot override resolved tenant.
- Tenant ID in URL cannot exist as an authorization mechanism because tenant URLs are not used.
- Provider secrets are never returned in API responses/logs.

---

# 23. Migration strategy

Do not rewrite all payment integrations at once.

Recommended sequence:

### Phase 1 — Foundation

- Create integration registry abstraction.
- Create webhook event persistence model.
- Create canonical event model.
- Create generic ingress route.
- Create provider adapter registry.

### Phase 2 — Payment provider

Migrate the first payment provider, preferably the provider currently used most heavily by Chrono.

- Implement signature verification.
- Implement provider account resolution.
- Implement tenant resolution.
- Normalize payment events.
- Connect to existing payment domain.
- Add idempotency.

### Phase 3 — Second provider

Migrate the next provider without changing the domain/payment architecture.

The second integration is the proof that the architecture is genuinely provider-independent.

### Phase 4 — Platform integrations

Move Chrono-owned billing integrations into the same centralized ingress pattern.

### Phase 5 — Remove legacy webhook routes

After traffic is migrated and verified:

- Disable old provider-specific routes.
- Remove duplicated handlers.
- Remove tenant-specific inbound webhook URLs.
- Update provider dashboards/configurations.

---

# 24. Acceptance criteria

The implementation is successful when:

- There is one centralized inbound webhook subsystem in `chrono-api`.
- There is one stable webhook URL pattern per provider, not per tenant.
- Platform and tenant integrations use the same ingress architecture.
- A tenant can connect/disconnect a provider without creating application routes.
- Payment webhooks resolve the correct tenant internally.
- Tenant resolution does not trust arbitrary tenant IDs from requests.
- Provider signature verification occurs before financial state changes.
- Duplicate provider events cannot duplicate financial effects.
- Provider payloads are normalized before reaching payment/business domains.
- Payment domain code does not contain PayMongo/Maya/Paddle webhook parsing.
- Adding another provider does not require creating tenant-specific routes.
- Unresolved financial events are retained for safe manual resolution rather than guessed.
- Platform and tenant financial data remain isolated.
- Logs and audit records can trace a webhook to the resulting payment and ledger transaction.

---

# 25. Recommended final mental model

The simplest rule for the team is:

> **Providers send events to Chrono. Chrono identifies the integration. The integration identifies the tenant. The canonical event identifies the business action. The domain owns the money.**

So the architecture becomes:

```text
                    PROVIDER
                       │
                       ▼
             /api/v1/webhooks/:provider
                       │
                       ▼
               WEBHOOK INGRESS
                       │
                       ▼
              PROVIDER ADAPTER
                       │
                       ▼
             SIGNATURE VERIFIED
                       │
                       ▼
            INTEGRATION RESOLVER
                 │           │
                 │           └── platform
                 │
                 └────────────── tenant
                       │
                       ▼
               CANONICAL EVENT
                       │
                       ▼
                DOMAIN SERVICE
                       │
              ┌────────┴────────┐
              ▼                 ▼
           PAYMENT           LEDGER
              │                 │
              └────────┬────────┘
                       ▼
                    WALLET
```

This is the pattern Chrono should standardize on before adding more payment providers.