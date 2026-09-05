# Chrono — apex `/support` page (real support/lead form + FAQ)

**Sessions:**
- Planning: mailtrap-e2e-email-verification [7ac5da]

**Depends on:** `.ai/plans/chrono/draft/apex-marketing-shell/README.md` landing first —
that plan creates the `(apex-marketing)` route group and its shared `layout.tsx`
(`MarketingHeader`/`MarketingFooter`, no tenant gating) this page's content sits inside,
and wires the nav/footer "Support" link to `/support`.

**Establishes a shared contract for:** `.ai/plans/chrono/draft/apex-company-contact/README.md`,
which reuses this plan's `/public/company-inquiries` endpoint with `source: "contact"`
instead of building a second one. That plan should not implement before this one lands.

**Status:** Accepted 2026-09-05, in `ready/`. Open questions 1-3 (auto-reply, exact
`SUPPORT_INBOX_EMAIL` value, `requestType` free-text-vs-dropdown) stand as documented
defaults unless the developer overrides them before/during implementation.

---

## Pass 1 — Workflow Analysis

**Who uses it:** a prospective business owner evaluating Chrono, or an existing tenant
admin who needs setup/demo/account help — on any host (apex or a tenant subdomain; the
marketing chrome renders identically everywhere per the shell plan).

**Workflow:** visitor opens `/support` → sees a hero, a 2x2 grid of support paths (Setup
guidance, Demo request, Account help, Workflow consultation), an FAQ accordion, and a
form (name, email, cafe/business name, request type, message) → submits → sees a real
confirmation state → IZUR's support inbox receives a real email with the submission.
No account, no tenant context, no session required.

**Failure cases:**
- Missing/invalid required field → 400, inline validation, no submission.
- Rate-limit exceeded (spam/bot) → 429 with `Retry-After`, form shows a rate-limited
  error, not a silent failure.
- Email provider unreachable at send time → the route must not silently claim success
  while dropping the lead. Decided here: validate + rate-limit first, then attempt the
  send; only return `{ submitted: true }` if the send succeeds (surface a 500 → the
  client shows a "couldn't send, try again" toast otherwise). This differs from
  `app-versions`' fallback stance because a lost GitHub read is a missed cache refresh
  (retried automatically 5 minutes later), while a lost lead here is permanently gone if
  the UI reports success anyway.
- Zero FAQ entries (defensive only — content is static, always non-empty).

**Audit / notifications:** the one notification this page produces is the outbound
email itself; nothing is written to any database, so there is nothing to audit-log.

---

## Pass 2 — Technical Planning

**Design reference (layout/UX/copy only — rebuilt fresh, not ported):**
`~/karta/karta-tenant/apps/chrono-web/src/app/(landing)/support/{page.tsx,support-client.tsx}`.
That reference's submission is **simulated** (`setTimeout`, no real backend) — this plan
replaces it with a real one. Its raw `div`/hardcoded `gold`/`zinc-950` chrome is exactly
what `.ai/rules/component-first-ui.md` and `.ai/rules/styling.md` prohibit here; every
visible affordance is rebuilt from `agora/ui` primitives and semantic tokens.

**Where it renders:** `apps/chrono-web/src/app/(apex-marketing)/support/page.tsx` — a
Server Component rendering static copy (hero, support-paths grid, `FaqItem`-based FAQ
list — `agora/ui`'s existing `FaqItem` component, already used by the homepage's own FAQ
section, takes `question` + children) plus a client form component,
`support-form.tsx`, alongside it. Content only — no header/footer, the group
`layout.tsx` (from `apex-marketing-shell`) supplies those.

**Where the backend lives:** `apps/chrono-api`, **not** `/rpc` (unauthenticated, no
tenant context). New module `apps/chrono-api/src/modules/company-inquiry/`:

- `contracts.ts` — `submitCompanyInquirySchema` (Zod): `name` (string, required),
  `email` (email, required), `businessName` (string, optional), `requestType` (string,
  required — free text mirroring the reference's "Demo, Setup, etc." placeholder, not an
  enum, since IZUR's own intake categories aren't fixed), `message` (string, required),
  `numberOfPcs` (positive int, optional), `numberOfBranches` (positive int, optional —
  both added upfront per `apex-company-contact`'s reconciliation note: that plan's
  sales-qualification form needs them on this same shared endpoint, so they're part of
  the schema from this phase rather than a follow-up migration), `source:
  z.enum(["support", "contact"])` (discriminator — this plan's page always sends
  `"support"` and omits both count fields; `apex-company-contact` sends `"contact"`
  with them populated when the visitor supplies them).
- `public-routes.ts` — `companyInquiryPublicRoutes()`, a `Hono()` mounted directly on
  `app` in `apps/chrono-api/src/app.ts` at `/public/company-inquiries` (mirroring
  `apps/chrono-api/src/modules/inquiry/public-routes.ts`'s shape exactly, but with no
  tenant resolution at all — there is no tenant here, this is about IZUR itself):
  1. Rate-limit by IP: `createRateLimiter(10, 60 * 60 * 1000, "company-inquiry-public")`
     + `clientIp(c)`, same 10/hour ceiling as the existing tenant inquiry limiter.
  2. Validate body against `submitCompanyInquirySchema`; 400 on failure.
  3. Send a real email via `getEmailSender()` (`agora`'s email provider,
     `packages/agora/src/core/server/providers/email/`) to a new env var
     `SUPPORT_INBOX_EMAIL` (documented in `.env.example`), containing the submission
     fields plus `source` in the subject/body so IZUR can tell support requests from
     general contact submissions in one inbox.
  4. Record the rate-limit hit (`.record(ip)`) only after a successful send, mirroring
     the existing inquiry route's order.
  5. Respond `{ submitted: true }`, 201. Never echo back a raw row (there is no row).

  **Deliberately no DB table.** A marketing lead/support form at this volume doesn't
  need a database + admin ticketing surface — that already exists, separately, as the
  platform-admin `supportTicket` console (`/admin/support`, internal ops tickets, an
  unrelated concern per `.ai/rules/rbac.md`). This mirrors the same "don't build a local
  mirror without an operational need" reasoning `app-versions` used to reject storing
  GitHub release history locally.

**No tenant table, no `APP_TENANT_TABLES` entry, no RLS impact.** This phase touches no
schema or tenancy, so `rls:proof` does not apply — stated explicitly so it isn't mistaken
for an oversight, same as `app-versions`.

---

## Explicitly out of scope (and why)

- **The platform-admin `supportTicket` console** (`/admin/support`) — already built,
  internal ops ticketing, unrelated to this public lead-capture form.
- **`apex-company-contact`'s own page content** — a sibling plan, but it depends on this
  plan's `/public/company-inquiries` endpoint and must not build a second one.
- **CAPTCHA / bot-detection beyond IP rate-limiting** — same divergence noted in the
  existing tenant inquiry route's own comments; out of scope here too.
- **Any DB-backed ticket/thread history for a submission** — see "Deliberately no DB
  table" above.

---

## Phase 1 — `/support` page + `/public/company-inquiries` backend

**Files to update:**
- New: `apps/chrono-api/src/modules/company-inquiry/contracts.ts` —
  `submitCompanyInquirySchema` + inferred type.
- New: `apps/chrono-api/src/modules/company-inquiry/public-routes.ts` —
  `companyInquiryPublicRoutes()` as designed above.
- Edit: `apps/chrono-api/src/app.ts` — mount `companyInquiryPublicRoutes()` at
  `/public/company-inquiries`, alongside the existing `/public/inquiries` mount.
- Edit: `.env.example` — add `SUPPORT_INBOX_EMAIL` with a comment.
- New: `apps/chrono-web/src/app/(apex-marketing)/support/page.tsx` — Server Component,
  static hero + support-paths grid + FAQ (`FaqItem`), composed only from `agora/ui`
  primitives (`Section`, `Card`, `Badge` if used, `FaqItem`).
- New: `apps/chrono-web/src/app/(apex-marketing)/support/support-form.tsx` —
  `"use client"`, controlled form (`Input`, `Label`, `Textarea`, `Button` from
  `agora/ui`, `toast` from `agora/ui` for the error path per `.ai/rules/ui.md`'s
  `Toaster`/`toast(...)` convention), posting to
  `${NEXT_PUBLIC_API_URL}/public/company-inquiries` with
  `{ ...fields, source: "support" }`, mirroring the tenant `ContactForm`'s
  (`apps/chrono-web/src/app/(saas-landing)/contact/client.tsx`) fetch pattern minus the
  tenant headers (none apply here).

**Step-by-step tasks:**
1. Write `contracts.ts` + `public-routes.ts` in the new `company-inquiry` module.
2. Mount the route in `app.ts`; add `SUPPORT_INBOX_EMAIL` to `.env.example`.
3. Manually verify the endpoint with `curl` against a running `chrono-api` dev server
   (valid payload → 201 + real email arrives at the configured inbox via the active
   `EMAIL_PROVIDER`; invalid payload → 400; 11th request within an hour from the same IP
   → 429).
4. Build `support/page.tsx` (static content) and `support-form.tsx` (the real submit
   flow), matching the reference's copy/section order without its raw HTML/hardcoded
   colors.
5. Confirm the shell plan's nav/footer "Support" entry now resolves to real content.

**Acceptance criteria:**
- Visiting `/support` on any host renders the hero, support-paths grid, FAQ, and form.
- Submitting valid data returns a real confirmation state and a real email lands in
  `SUPPORT_INBOX_EMAIL` via the active email provider — not a simulated timeout.
- Invalid/missing fields are rejected client- and server-side.
- 11 submissions from the same IP within an hour → the 11th is rate-limited (429).
- Every visible affordance is built from `agora/ui` primitives — no raw
  `div`/`button`/hardcoded hex, per `.ai/rules/component-first-ui.md` and
  `.ai/rules/styling.md`.
- No new DB table, no `APP_TENANT_TABLES` entry, no new permission resource, no `/rpc`
  route added.

**Verification commands:**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-api dev` + a manual `curl -X POST
  http://localhost:8787/public/company-inquiries` smoke test (valid, invalid, and
  rate-limit-triggering payloads).
- `pnpm --filter @agora/chrono-web dev`, load `/support` on `APP_DOMAIN:3000`, submit the
  form, confirm the email arrives.
- No `rls:proof` run required — this phase touches no schema/tenancy/RLS.

**Out of scope (phase-level):** the `supportTicket` admin console, CAPTCHA, any DB-backed
history, `apex-company-contact`'s own page (depends on this phase's endpoint only).

**Execution start point:** confirm `SUPPORT_INBOX_EMAIL`'s value and which
`EMAIL_PROVIDER` is active in dev with the developer, then start at Task 1
(`company-inquiry` module) — it has no dependency on the page and can be curl-verified
before any UI is built.

---

## Open Questions (developer to confirm/override)

1. Should a successful submission also auto-reply to the submitter's own email (e.g. "we
   received your request"), or is a one-way notification to IZUR's inbox enough for now?
   Defaulted here to one-way — simplest, matches the reference's own (simulated) UX
   which only showed a confirmation, never claimed an auto-reply was sent.
2. Exact wording/value for `SUPPORT_INBOX_EMAIL` (which real inbox this should hit) —
   needs the developer's input, not guessed.
3. Should `requestType` become a fixed `Select` (like the tenant `/contact` form's
   category dropdown) instead of free text, once real submissions show what categories
   IZUR actually gets? Left as free text for the MVP per the reference's own placeholder
   ("Demo, Setup, etc."), revisit once volume exists.
4. ~~Reconcile `numberOfPcs`/`numberOfBranches`~~ — resolved 2026-09-05: added to this
   plan's own schema upfront (see Pass 2) since `apex-company-contact`'s dependency on
   this endpoint was already known when this plan was reviewed.

---

## After Implementation

**Status: Implemented 2026-09-05.** Phase 1 landed in two commits, split at the
plan's own backend/frontend seam so `apex-company-contact` could start the
moment the endpoint was verified:

- `feat(chrono-api): add public company-inquiry lead-capture endpoint` —
  `contracts.ts` + `public-routes.ts` (`apps/chrono-api/src/modules/
  company-inquiry/`), mounted at `POST /public/company-inquiries` in
  `apps/chrono-api/src/app.ts`, plus `SUPPORT_INBOX_EMAIL` in
  `apps/chrono-api/.env.example`.
- `feat(chrono-web): add apex Support page with a real lead-capture form` —
  `apps/chrono-web/src/app/(apex-marketing)/support/{page.tsx,support-form.tsx}`.

**Verification:** `pnpm typecheck` (both packages + full workspace) passes.
No `rls:proof` — no schema/tenancy touched. Backend curl smoke test: valid
support/contact payloads → 201 + a real console-provider email logged;
invalid payload → 400; 11th request from one IP within the hour → 429 with
`Retry-After`. Full browser verification via Playwright against a live dev
server: `/support` renders the hero/paths/FAQ/form, submitting the form
returns a real 201, a real email is logged, and the UI swaps to the
"Message sent" confirmation state.

**Deviations from the plan** (documented in the commit messages too):
1. The two internal-failure throws (`SUPPORT_INBOX_EMAIL` unset, email-send
   failure) use a plain thrown `Error`, not `HttpError(500, ...)` —
   `HttpError`'s status union has no `500`; these fall through to the app's
   existing catch-all `onError` handler instead, the same path every other
   unexpected server-side failure already takes.
2. The FAQ section reuses the existing local `FaqAccordion`
   (`apps/chrono-web/src/components/landing/faq-accordion.tsx`) instead of
   `agora/ui`'s `FaqItem` — the plan's premise that `FaqItem` was already used
   by the homepage's FAQ section didn't hold (the homepage actually uses
   `FaqAccordion`), and `FaqAccordion` matches the rest of the marketing
   site's established look.

**Open Questions 1-3** stand resolved at their stated defaults (one-way
notification only, `requestType` stays free text). **Question 2** (the real
`SUPPORT_INBOX_EMAIL` value) is still a placeholder in `.env.example`
(`support@example.com`) — the developer must set the real inbox address in
their own `.env` before this goes to any real environment; until then the
route 500s in a fresh environment that hasn't set it, by design (see Pass 1's
failure-case stance — never silently claim success while dropping a lead).

**Not implemented:** the `apex-company-contact` page itself (a sibling plan,
now unblocked — it can build directly against the endpoint's field names and
response shape verified here: `{ name, email, businessName?, requestType,
message, numberOfPcs?, numberOfBranches?, source }` → `{ submitted: true }`,
201).
