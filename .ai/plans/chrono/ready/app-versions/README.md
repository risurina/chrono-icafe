# Chrono — `app-versions` (PC-client release info)

**Sessions:**
- Planning: mailtrap-e2e-email-verification [7ac5da] (original: consolidate-customers-members-page [7ffb50])

**Depends on:** `.ai/plans/chrono/draft/apex-marketing-shell/README.md` landing first —
that plan creates the `(apex-marketing)` route group + shared layout
(`MarketingHeader`/`MarketingFooter`, no tenant gating) this page's Phase 1 now targets.

**Status:** re-opened from `blocked/` on 2026-09-05. The original blocking premise —
"no PC-client binary exists to version" — is factually false: a real, code-signed
Tauri client already ships releases from a separate repo. This document replaces the
prior Pass 1/2 entirely per `.ai/rules/feature-planning.md` ("its Pass 2 must be redone
against current reality").

## What changed since the original block

The original plan (superseded, see git history) assumed `app-versions` had to be an
in-house release **registry**: a table an operator promotes `draft → pilot →
production`, consumed by a bearer-authenticated device via the not-yet-built `devices`
module. Investigation on 2026-09-05 found:

1. **`izur-it/chrono` (public GitHub repo) is the real release feed.** It already has
   four tagged releases (`v0.1.0`–`v0.1.3`, latest 2026-07-15), each with a code-signed
   `.exe` installer and a Tauri-updater `.sig` file. Root contents are just
   `README.md` — it is a **releases-only distribution repo**; the PC-client's actual
   source lives elsewhere, outside this workspace's remit. Agora only needs to
   **consume** its published releases, never build or own the client itself.
2. **A live reference implementation already exists**: `https://chrono.izur.com.ph/download`
   renders exactly this — version, date, size, changelog, code-signing note, a download
   link straight to the GitHub release asset — sourced live from GitHub, no local
   database behind it.
3. **The developer confirmed this is a distinct, separate concept** from a possible
   future "which Agora/Chrono platform release is this tenant running" surface (that
   would read `risurina/agora`'s own releases, currently zero — out of scope here,
   not to be conflated with this plan).

This kills all three original blockers:

- **No permission/admin-surface question** — this isn't a mutate-and-promote registry
  anymore. It's a public, read-only render of an external feed. No new permission
  resource, no platform-admin vs. tenant-admin surface decision needed.
- **No device identity/bearer-auth dependency** — nothing calls in as an authenticated
  device. The one place a "device" would check for updates is the installed Tauri
  app's own native updater, pointed directly at GitHub — see "Explicitly out of scope,"
  below.
- **No missing producer** — real, signed binaries already exist and ship to
  `izur-it/chrono`.

---

## Pass 1 — Workflow Analysis

**Who uses it:** a tenant admin setting up a new station, or any public visitor,
wants to download the Chrono PC Client installer. Not tenant-scoped — the same page,
same content, for every tenant.

**Workflow:** visitor opens the download page → sees the current version, changelog,
file size/requirements, a code-signing note → clicks "Download for Windows" → lands
directly on the GitHub release asset URL. No account, no tenant context, no session
required.

**Failure cases:**
- GitHub API unreachable or rate-limited → page must degrade to a cached/last-known
  version or a plain "view releases on GitHub" fallback link — never a 500.
- Zero releases (defensive only; four exist today) → empty state, not a crash.

**Audit / notifications:** none. Pure read-only public content; nothing mutates.

---

## Pass 2 — Technical Planning

**Source of truth:** `GET https://api.github.com/repos/izur-it/chrono/releases`
(public repo; unauthenticated calls are rate-limited to 60/hr per source IP — fine
given server-side response caching, see below, but confirm/decide on a token in Phase 1
Task 2).

**Where it lives:** `apps/chrono-web` only. No `apps/chrono-api` route, no new table:

- **No new tenant table.** This is external data, not tenant data — nothing to store,
  GitHub is the record of truth, not mirrored locally.
- **No `APP_TENANT_TABLES` entry, no RLS impact.** This phase makes zero schema change,
  so the "touched tenancy/RLS/schema → `rls:proof`" gate in `AGENTS.md` does not apply —
  stated explicitly so it isn't mistaken for an oversight.
- **No `/rpc` route, no `tenantMiddleware()`, no permission gate.** The data is public
  and identical for every tenant; a Next.js Server Component fetching GitHub directly
  (with `next: { revalidate }` caching) is the whole surface. Confirmed against the
  existing `(saas-landing)/about/page.tsx` and `(saas-landing)/contact/page.tsx`
  patterns in `apps/chrono-web/src/app/` — both are async Server Components composed
  from `agora/ui` (`PageShell`, `Main`), not raw HTML.

**Where it renders:** `apps/chrono-web/src/app/(apex-marketing)/download/page.tsx` — a
new route group, not `(saas-landing)`. Investigation during this planning pass found
`(saas-landing)/about` and `/contact` were **repurposed** into each tenant's own
configurable landing content (a registry-driven "About" section, and a real
tenant-scoped "submit an inquiry to this cafe" form posting to `/public/inquiries`) —
they 404 without a tenant and are not the apex marketing pages an earlier plan note
assumed. `apps/chrono-api/AGENTS.md` now states the apex marketing page is the single
`(saas-landing)/page.tsx`. This page, `/support`, `/pricing`, `/terms`, `/privacy`, and
the company `/company/about` + `/company/contact` pages are new, genuinely apex-only
content with no existing route to collide with, so they get their own group:
`(apex-marketing)`, built by the `apex-marketing-shell` plan this one depends on. That
shell's `layout.tsx` wraps every page in the group with the existing
`MarketingHeader`/`MarketingFooter` (`@/components/landing/marketing-chrome`, already
used by the homepage) — no tenant gating, renders identically on any host — so this
page's own file needs no header/footer/PageShell of its own, only its content.

**Caching:** GitHub's unauthenticated rate limit (60/hr/IP) is the reason this must not
be a client-side fetch — a Next.js server `fetch()` with `next: { revalidate: 300 }` (5
min) keeps real GitHub calls low regardless of visitor traffic, and gives a
last-known-good cached response to fall back on if GitHub is briefly down.

---

## Explicitly out of scope (and why)

- **Building or porting `apps/chrono-pc-client`'s actual source into this workspace.**
  Its source lives outside this repo entirely; `izur-it/chrono` is a binary-distribution
  target, not something this plan builds.
- **Device pairing / bearer-auth (`devices` module).** Unrelated to this rescoped plan —
  nothing here authenticates as a device.
- **A local database mirror of release history.** GitHub remains the sole source of
  truth; mirroring it would be a second, driftable copy for no benefit at this scale
  (four releases, low traffic).
- **The installed Tauri app's own auto-update check.** Tauri v2 supports pointing its
  updater natively at a GitHub releases endpoint (a `latest.json`-shaped manifest
  asset) with zero custom backend. That configuration lives in the PC-client's own
  `tauri.conf.json`, in a repo this workspace has no access to or ownership of. This
  plan's deliverable is the human-facing download page only; confirming or wiring the
  Tauri updater endpoint is a task for whoever owns that repo, tracked as an open
  question below, not a phase here.
- **The separate "which Agora/Chrono platform release is this tenant running" surface**
  (would read `risurina/agora`'s own releases). Confirmed by the developer to be a
  distinct, unrelated feature — not addressed by this plan.

---

## Phase 1 — Public PC-client download page

**Files to update:**
- New: `apps/chrono-web/src/app/(apex-marketing)/download/page.tsx` — async Server
  Component. Content only (no header/footer — the group `layout.tsx` from
  `apex-marketing-shell` supplies those): a hero (`Section`) with copy + a requirements
  grid (Windows 10/11 64-bit, x64, ~200MB free, admin install) on one side and a
  download `Card` for the latest release (version, "Download for Windows" `Button`, a
  SmartScreen note) on the other, then a `#releases` section listing every release
  (`Card` per release: name/version/date/size `Badge`s, its own download `Button`,
  release notes rendered plain — latest expanded, older ones behind a collapsible
  `Accordion`/`Collapsible` from `agora/ui`). This mirrors oikos's reference
  (`~/karta/karta-tenant/apps/chrono-web/src/app/(landing)/download/download-client.tsx`)
  for layout/UX only — rebuilt fresh from `agora/ui` primitives and semantic tokens, not
  ported (its raw HTML chrome, hardcoded `gold`/`zinc-950` literals, and hand-rolled
  markdown renderer are exactly what `.ai/rules/component-first-ui.md` and
  `.ai/rules/styling.md` prohibit here).
- New: `apps/chrono-web/src/lib/pc-client-releases.ts` — server-only helper:
  `getPcClientReleases()` fetching `https://api.github.com/repos/izur-it/chrono/releases`
  with `next: { revalidate: 300 }`, mapped to a small local type (not a `packages/agora`
  contract — this is app-external data, not a cross-app transport shape):
  `{ version: string; publishedAt: string; sizeBytes: number; downloadUrl: string;
  notes: string; isLatest: boolean }[]`. Returns `[]` (never throws) on fetch failure so
  the page can render its fallback state.
- New (optional, only if the release body needs it): a small markdown-to-safe-text
  renderer for the GitHub release body, or render as preformatted text — decide in
  Task 3 below based on how the existing release bodies are formatted (checked: they
  use standard markdown headers/lists).

**Step-by-step tasks:**
1. Write `getPcClientReleases()` in `apps/chrono-web/src/lib/pc-client-releases.ts`,
   calling the GitHub REST API with `Accept: application/vnd.github+json`, mapping the
   response's `assets` array to find the `.exe` (installer) asset per release for
   `downloadUrl`/`sizeBytes`, and `tag_name`/`published_at`/`body` for the rest. First
   release in the array with no `draft`/`prerelease` flag (or the one GitHub marks
   `isLatest`, confirmed via `gh release view --json` field names during planning) is
   `isLatest: true`.
2. Decide and document whether to call the GitHub API unauthenticated or with a
   read-only PAT (`GITHUB_RELEASES_TOKEN`, new env var if chosen) to raise the rate
   ceiling — default to unauthenticated given `revalidate: 300` keeps real call volume
   near-zero; add the token only if production logs show rate-limit errors.
3. Build `apps/chrono-web/src/app/(saas-landing)/download/page.tsx`: `PageShell` +
   `Main`, a `Card` per release (`agora/ui`) — latest one has a `Badge` "Latest" and a
   primary `Button` linking to `downloadUrl`; older releases collapse to a simple list
   with their own download links. Render `notes` as plain text/simple markdown, not
   raw `dangerouslySetInnerHTML`.
4. Empty/failure state: if `getPcClientReleases()` returns `[]`, render a single `Card`
   with a message and a plain link to `https://github.com/izur-it/chrono/releases` —
   never a 500 page.
5. Add basic requirements copy (Windows 10/11 x64, WebView2 auto-installed) as static
   text — this doesn't come from the GitHub API, mirror the existing
   `chrono.izur.com.ph/download` copy for accuracy.

**Acceptance criteria:**
- Visiting `/download` on the apex host renders the current release list matching
  `izur-it/chrono`'s actual GitHub releases (verify against `gh release list --repo
  izur-it/chrono` at test time).
- Every visible affordance is built from `agora/ui` primitives (`Section`, `Card`,
  `Badge`, `Button`, `Accordion`/`Collapsible`) — no raw `div`/`button` chrome, per
  `.ai/rules/component-first-ui.md`. Header/footer come from the group `layout.tsx`,
  not this page.
- Simulating a GitHub fetch failure (e.g., temporarily pointing the helper at an
  invalid URL) renders the fallback state, not a 500.
- No new DB table, no `APP_TENANT_TABLES` entry, no new permission resource, no
  `/rpc` route added.

**Verification commands:**
- `pnpm typecheck`
- `pnpm --filter @agora/chrono-web dev`, then manually load `/download` on
  `APP_DOMAIN:3000` and confirm it matches `gh release list --repo izur-it/chrono`.
- No `rls:proof` run required — this phase touches no schema/tenancy/RLS.

**Out of scope (phase-level, restates plan-level section above):** Tauri
auto-update wiring, any `devices`/bearer-auth work, any local release table, the
separate platform-version display.

**Execution start point:** confirm Task 2's token decision with the developer (or
default to unauthenticated per the stated default), then start at Task 1
(`pc-client-releases.ts`) — it has no dependency on the page shell and can be built
and manually verified (e.g. a temporary console log of its output) before Task 3.

---

## Open Questions (developer to confirm/override)

1. ~~Should the download page also be linked from inside the tenant dashboard~~ —
   resolved 2026-09-05: not now, public page only. Instead it's linked from the apex
   marketing nav/footer (`apex-marketing-shell` plan adds a "Download" entry).
2. Confirm with whoever owns the PC-client's actual source repo that its Tauri updater
   is (or will be) configured to check `izur-it/chrono` releases directly — this plan
   assumes that wiring is either already done or someone else's task, and does not
   verify it (no access to that source).
3. ~~Exact route path~~ — resolved 2026-09-05: `(apex-marketing)/download`, no
   collision (see "Where it renders" above).

---

## After Implementation

Not yet — this plan is accepted and in `ready/`, but depends on `apex-marketing-shell`
landing first (see "Depends on" above). Claiming `Implementation:` + committing Phase 1
is the move to `in-progress/`, per `.ai/rules/feature-planning.md`.
