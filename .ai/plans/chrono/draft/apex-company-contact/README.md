# Chrono — apex `/company/contact` (Contact IZUR)

**Sessions:**
- Planning: mailtrap-e2e-email-verification [7ac5da]

**Depends on:**
- `.ai/plans/chrono/draft/apex-marketing-shell/README.md` landing first — provides the
  `(apex-marketing)` route group and its shared layout
  (`MarketingHeader`/`MarketingFooter`, no tenant gating) this page's content sits
  inside.
- `.ai/plans/chrono/draft/apex-support-page/README.md` landing first — that plan builds
  the shared `POST /public/company-inquiries` backend (module
  `apps/chrono-api/src/modules/company-inquiry/`) this page's form reuses with
  `source: "contact"`. This plan does **not** build a second backend endpoint. It does,
  however, require that shared contract to gain two additional **optional** fields
  (`numberOfPcs`, `numberOfBranches`, both positive integers) — **resolved 2026-09-05:**
  `apex-support-page`'s own plan now includes both fields upfront (see that plan's Pass
  2), so this plan no longer needs to extend the schema itself; it only needs
  `apex-support-page` to have landed first.

**Status:** Draft (not yet accepted — do not implement).

---

## Design reference (read for layout/UX/copy only — not ported as code)

`/Users/risurina/karta/karta-tenant/apps/chrono-web/src/app/(landing)/contact/page.tsx`
+ `apps/chrono-web/src/components/platform/landing/forms/ContactForm.tsx`. Read in full
during this planning pass.

**Important correction to the assumption in this plan's own directive:** oikos does
**not** have two separate contact-form components (one tenant, one apex). It has **one**
`ContactForm` that host-branches on an `isTenant` flag — exactly the same
"same file, render everywhere, branch internally" pattern
`apps/chrono-api/AGENTS.md` documents for agora's own `/login` and the homepage. When
`isTenant` is false (apex, no resolved tenant), oikos's form becomes a genuine
**sales-qualification lead form**, not a generic "send us a message" box:

- Heading: *"Talk to IZUR about your cafe operations."*
- Subtext: *"Tell us about your cafe setup, number of PCs, and rollout goals. We'll
  help you understand how Chrono can fit your workflow."*
- A "Best for:" bullet list (apex-only): General inquiries · Support requests · Rates
  and membership · Booking or events · Feedback and suggestions.
- A small badge: *"Chrono is built and supported by IZUR IT Solutions."*
- Form fields (apex-only, in addition to the always-present Name/Email/Message):
  **Cafe/Business Name** (optional text), **Number of PCs** (optional positive int),
  **Number of branches** (optional positive int). Message is required, capped at 2000
  chars client-side.
- Success state: *"Message Sent" / "Thank you for reaching out. Our team will get back
  to you within 24 hours."*
- oikos posts to `/api/contact` with `source: "chrono_contact_page"` and guards
  submission with reCAPTCHA (`useRecaptcha`/`buildCaptchaHeaders`) — **no reCAPTCHA
  integration exists anywhere in this codebase today**; introducing one is out of scope
  for this plan (see below). This codebase's established anti-abuse pattern for public
  forms is a per-IP rate limiter (`createRateLimiter`/`clientIp` from `agora/server`,
  already used by the tenant `/public/inquiries` route and by `apex-support-page`'s new
  endpoint) — rely on that instead, consistent with every other public route in
  `apps/chrono-api/AGENTS.md`'s "Unauthenticated routes" section.

This is unrelated to, and must not touch, the **existing, already-built**
`apps/chrono-web/src/app/(saas-landing)/contact/page.tsx` — a real, tenant-scoped
"submit an inquiry to this specific cafe" form (POSTs to `/public/inquiries`, 404s
without a tenant, backed by `chronoInquiry`/`chronoInquiryMessage`). This new page is
IZUR-the-vendor's own contact page, apex-only (renders the same for every host, per
`apex-marketing-shell`'s layout), living at a new, non-colliding path.

---

## Pass 1 — Workflow Analysis

**Who uses it:** a prospective cafe owner sizing up Chrono, a press/partner inquiry, or
anyone wanting to reach IZUR directly rather than through `/support`'s FAQ-first flow.
Not tenant-scoped — identical content on any host.

**Workflow:** visitor reads company contact copy + the "best for" list → fills name,
email, optionally business name / PC count / branch count, and a message → submits →
sees a real "Message sent" confirmation → IZUR receives a real email (via the shared
`/public/company-inquiries` endpoint, `source: "contact"`).

**Failure cases:**
- Missing/invalid required field (name, email, message) → inline validation error,
  mirroring oikos's per-field error copy ("Name is required", "Invalid email address",
  "Message cannot exceed 2000 characters") — client-side check before submit, plus
  server-side Zod validation (never trust the client alone).
- Rate-limited (spam/abuse) → 429, "Too many attempts. Try again later," matching the
  shared endpoint's existing behavior from `apex-support-page`.
- Email provider unreachable → decide consistently with `apex-support-page`'s own
  resolution of this (see that plan's Pass 1) — do not diverge into a second policy for
  the same endpoint.

**Audit / notifications:** none beyond the email `apex-support-page` already sends to
`SUPPORT_INBOX_EMAIL`; no DB row, so nothing to audit.

---

## Pass 2 — Technical Planning

**Where it lives:** `apps/chrono-web` only — no `apps/chrono-api` changes in this plan
(the backend is entirely owned by `apex-support-page`).

- **No new DB table.** No new `/rpc` route. No tenant/RLS impact — `rls:proof` does not
  apply, this phase touches no schema or tenancy.
- **Route:** `apps/chrono-web/src/app/(apex-marketing)/company/contact/page.tsx` (a thin
  Server Component rendering metadata) + a `"use client"` form component, e.g.
  `apps/chrono-web/src/app/(apex-marketing)/company/contact/contact-form.tsx`. Content
  only — no header/footer (the group `layout.tsx` from `apex-marketing-shell` supplies
  those).
- **Contract already covers this page's fields:** `apex-support-page`'s
  `POST /public/company-inquiries` Zod schema now includes `numberOfPcs` (positive int,
  optional) and `numberOfBranches` (positive int, optional) alongside its own fields —
  added there upfront once this dependency was known (resolved 2026-09-05). This page
  simply omits `requestType` (support's own field) and populates the two count fields
  when the visitor supplies them. No schema change happens in this plan.
- **UI:** rebuilt from `agora/ui` primitives only (`Section`, `Card`/`Box`-equivalent,
  `Input`, `Label`, `Textarea`, `Button`, `Badge`) — no raw HTML chrome, no hardcoded
  hex/`gold`/`zinc` literals, per `.ai/rules/component-first-ui.md` and
  `.ai/rules/styling.md`. Client-side validation errors rendered via each field's own
  error text (mirroring oikos's per-field messages), not a single generic banner.

---

## Explicitly out of scope

- The shared `/public/company-inquiries` backend itself (owned by `apex-support-page`;
  this plan only requests the two extra optional fields on it).
- reCAPTCHA / any bot-challenge integration — no such integration exists in this
  codebase today; introducing one is a separate, foundation-level decision, not bundled
  into a single contact-page plan. The per-IP rate limiter is the accepted mitigation
  for now.
- The tenant's own `/contact` inquiry form (`(saas-landing)/contact`) — untouched.
- Any CRM/lead-tracking system for these submissions — they are plain emails, same
  scope decision `apex-support-page` already made for its own form.

---

## Phase 1 — `/company/contact` page + form

**Files to update:**
- New: `apps/chrono-web/src/app/(apex-marketing)/company/contact/page.tsx` — Server
  Component, sets `<Metadata>` (title "Contact — Chrono", description mirroring oikos's
  "Talk to us about your inquiry."), renders the client form component.
- New: `apps/chrono-web/src/app/(apex-marketing)/company/contact/contact-form.tsx` —
  `"use client"`, holds form state, calls `POST {NEXT_PUBLIC_API_URL}/public/company-inquiries`
  with `{ name, email, businessName?, numberOfPcs?, numberOfBranches?, message,
  source: "contact" }`, shows the success state on `{ submitted: true }`, surfaces a
  `toast.error(...)` (per `.ai/rules/ui.md`'s `Toaster`/`toast` convention) on non-2xx
  rather than oikos's inline banner-only approach — keep the per-field inline errors too
  for required-field/format validation, matching oikos's UX.
**Step-by-step tasks:**
1. Confirm `apex-support-page` has landed (its schema already includes
   `numberOfPcs`/`numberOfBranches` — nothing to extend here).
2. Build `contact-form.tsx`: fields Name*, Email*, Cafe/Business Name, Number of PCs,
   Number of branches, Message* (max 2000 chars, client-side counter/limit), submit
   button "Send Request" (disabled + "Sending…" while in flight).
3. Wire client-side validation matching oikos's rules: name/email/message required;
   email format check; message length cap; numberOfPcs/numberOfBranches must be a
   positive integer if provided.
4. On success, replace the form with a confirmation panel + a "Send another message"
   reset action (mirrors oikos).
5. Build `page.tsx` with metadata and mount the form inside `(apex-marketing)`'s shared
   layout (no header/footer of its own).
6. Add copy: heading, subtext, and the "Best for" bullet list + IZUR support badge,
   matching the reference content above (rewritten in this app's own voice/tone if the
   developer prefers — flagged as an open question below).

**Acceptance criteria:**
- Visiting `/company/contact` on any host (apex or a tenant subdomain) renders identical
  content — no tenant gating, no 404.
- Submitting valid data creates a real email to `SUPPORT_INBOX_EMAIL` via the shared
  endpoint with `source: "contact"`, and the page shows a real success state (not
  simulated).
- Submitting invalid data (missing name/email/message, malformed email, non-positive
  PC/branch counts) is blocked client-side with inline errors before any network call.
- Every visible affordance is built from `agora/ui` primitives — no raw `div`/`button`
  chrome, no hardcoded colors.
- No new DB table, no `APP_TENANT_TABLES` entry, no new tenant permission.

**Verification commands:**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-web dev` (+ `chrono-api` running), manually submit the
  form and confirm a real email arrives at the configured support inbox (or check
  Mailtrap/whatever `EMAIL_PROVIDER` is configured for local dev).
- No `rls:proof` run required — no schema/tenancy touched.

**Out-of-scope (phase-level):** reCAPTCHA, CRM/lead tracking, the tenant `/contact`
form, the shared backend's core build-out (owned by `apex-support-page`).

**Execution start point:** confirm `apex-support-page` is implemented, then build
`contact-form.tsx` first — it can be smoke-tested against the running `chrono-api`
endpoint before `page.tsx`/layout wiring is finished.

---

## Open Questions (developer to confirm/override)

1. ~~Reconcile `numberOfPcs`/`numberOfBranches`~~ — resolved 2026-09-05:
   `apex-support-page`'s schema now includes both fields upfront.
2. Copy: use oikos's exact wording ("Talk to IZUR about your cafe operations...") or
   have the developer supply this app's own marketing voice? Defaulted to matching
   oikos's copy closely for now, as with `apex-support-page`'s FAQ content.
3. Confirm `/company/contact` is the right final path (vs., e.g., a single combined
   `/support` page with a "talk to sales" tab) — this plan assumes the two-page split
   the developer already confirmed in this session (separate `/support` and
   `/company/contact` pages) still stands.

---

## After Implementation

Not yet — this plan is in `draft/`. Per `.ai/rules/feature-planning.md`, it needs the
developer's explicit acceptance (and to pass the Concreteness Gate above) before moving
to `ready/`, and claiming `Implementation:` + committing Phase 1 before moving to
`in-progress/`.
