# Plan: replace Guerrilla Mail with Mailtrap for real-send e2e verification

**Depends on:** `.ai/plans/agora/archive/mailtrap-email-provider/README.md` (adds the
`mailtrap` sender this plan sends through) — implemented (commits `8a3dea52`,
`7e4d59ca`), confirmed by `replicate-chrono-member-area [3bcec6]`.

**Sessions:**
- Implementation: `mailtrap-e2e-email-verification [7ac5da]`

## Context / why

`apps/chrono-web/e2e/tests/settings/members-invite.spec.ts` has one test ("invitee
accepts the invite via the emailed link") that proves the *real*, configured email
provider actually delivers a working invite — every other e2e spec instead greps
the dev server's stdout log for the console-driver's `[email:console] to=...
link=...` line (see `findInviteLink()` in e.g.
`apps/chrono-web/e2e/tests/members/members.spec.ts:7`).

Today that one real-send test sends via `EMAIL_PROVIDER=resend` and reads the email
back via **Guerrilla Mail** (`apps/chrono-web/e2e/utils/temp-inbox.ts`) — a free,
keyless, unauthenticated public disposable-inbox API with no reliability/SLA
guarantee. Mailtrap's Testing (sandbox) product is purpose-built for exactly this
case instead: it captures whatever is sent through it without ever delivering to a
real recipient, and exposes a keyed REST API to read captured messages back.

**Decision (confirmed with the developer):** replace Guerrilla Mail with Mailtrap.
Scope is **chrono-web only** — `apps/agora-web`'s own `temp-inbox.ts`/
`members-invite.spec.ts` stay on Guerrilla Mail for now, by explicit choice.

## Key decisions

1. **One shared sandbox inbox, correlate by recipient email — no per-test
   provisioning.** `apps/chrono-web/playwright.config.ts` already runs
   `fullyParallel: false, workers: 1`, so there is no concurrent-test race on a
   shared inbox. This mirrors the existing console-log-grep convention exactly
   (`findInviteLink()` greps one shared log file for `to=<uniqueEmail>`) — just
   against Mailtrap's Testing API instead of a log file. Use the already-
   provisioned `chrono` sandbox inbox (id `277668`, project `196465`, account
   `278030`) — no inbox-per-test creation, no cleanup step.
2. **No real receiving address needed anymore.** Mailtrap Testing never delivers,
   so `newTempInbox()`'s job (reserve a real, externally-reachable disposable
   address) goes away — the spec just generates a normal unique fake email via the
   existing shared `apps/chrono-web/e2e/utils/faker.ts`
   (`faker.internet.email({ provider: "example.com" })`), same as every other spec.
3. **Test-runner-only env vars are documented inline, not in `.env.example`** —
   matching the existing `DEV_LOG_PATH` precedent (`process.env.DEV_LOG_PATH ??
   "/tmp/agora-dev.log"` in `findInviteLink()`, never added to any `.env.example`).
   `MAILTRAP_ACCOUNT_ID` (needed only by the Playwright process, for Mailtrap's
   `GET /api/accounts/{account_id}/inboxes/{inbox_id}/messages`) follows that same
   pattern. `MAILTRAP_API_TOKEN` / `MAILTRAP_TEST_INBOX_ID` are needed by **both**
   the API server (to send, via Plan A) and the test runner (to read back) —
   documented once in `apps/chrono-api/.env.example` (server-side precedent:
   `RESEND_API_KEY` etc.), read directly via `process.env` on the test-runner side.

## Files to update

1. `apps/chrono-web/e2e/utils/mailtrap-inbox.ts` (new, replaces `temp-inbox.ts`)
2. `apps/chrono-web/e2e/utils/temp-inbox.ts` (deleted)
3. `apps/chrono-web/e2e/tests/settings/members-invite.spec.ts` (edit)
4. `apps/chrono-api/.env.example` (edit)

## Step-by-step tasks

1. **Confirm the live Mailtrap Testing API shape first — do not guess.** Using the
   developer's `MAILTRAP_API_TOKEN`, make one real authenticated request to confirm:
   the exact list/search-messages endpoint (expected shape:
   `GET https://mailtrap.io/api/accounts/{account_id}/inboxes/{inbox_id}/messages`
   with a `search` query param — mirrors the `search` field on the
   `mcp__mailtrap__get-sandbox-messages` tool already proven working this session),
   the exact HTML-body-fetch endpoint/path, and the exact auth header name/format.
   The MCP server's own internal calls aren't inspectable from here, so this is a
   live-verified fact, not an assumption baked into the code.
2. **`mailtrap-inbox.ts`** — same poll-loop shape as the deleted
   `findInviteLinkInTempInbox` (60s deadline, 2s interval):
   ```ts
   export async function waitForMailtrapInviteLink(toEmail: string): Promise<string>
   ```
   Searches the shared inbox for a message addressed to `toEmail`, fetches its HTML
   body, regex-extracts `/accept-invite\?token=[^"]+/` (same pattern as the deleted
   util). Reads `MAILTRAP_API_TOKEN`, `MAILTRAP_ACCOUNT_ID`, `MAILTRAP_TEST_INBOX_ID`
   from `process.env`, throwing a clear error naming the missing var if any is unset.
   Document all three in a header comment (no `.env.example` entry — matches the
   `DEV_LOG_PATH` precedent).
3. **`members-invite.spec.ts`**:
   - Drop `import { findInviteLinkInTempInbox, newTempInbox } from "../../utils/temp-inbox"`.
   - Add `import { faker } from "../../utils/faker"` and
     `import { waitForMailtrapInviteLink } from "../../utils/mailtrap-inbox"`.
   - Replace `const inbox = await newTempInbox(); const inviteeEmail = inbox.email;`
     with `const inviteeEmail = faker.internet.email({ provider: "example.com" });`.
   - Replace `await findInviteLinkInTempInbox(inbox)` with
     `await waitForMailtrapInviteLink(inviteeEmail)`.
   - Update the file's top docstring (currently: "reading the accept link back out
     of a real disposable inbox after a real send through `EMAIL_PROVIDER=resend`")
     to describe the Mailtrap sandbox flow instead.
   - Add a one-line operational comment: this spec's third test requires the
     chrono-api dev server to be running with `EMAIL_PROVIDER=mailtrap` (+
     `MAILTRAP_API_TOKEN` + `MAILTRAP_TEST_INBOX_ID`) set.
4. **`apps/chrono-api/.env.example`** — extend the existing "Transactional email"
   block (mirrors the `resend`/`mailgun` bullets already there) with a `mailtrap`
   line and commented-out `MAILTRAP_API_TOKEN` / `MAILTRAP_TEST_INBOX_ID` examples,
   noting they're for e2e testing only and pointing at `mailtrap-inbox.ts`.

## Acceptance criteria

- [ ] `members-invite.spec.ts`'s three tests pass against a chrono-api dev server
      started with `EMAIL_PROVIDER=mailtrap` + the two env vars. **Not run this
      session** — no `MAILTRAP_API_TOKEN`/`MAILTRAP_TEST_INBOX_ID` available to set
      on the chrono-api dev server (the connected `mcp__mailtrap__*` tools don't
      expose the raw token). Needs the developer to run it locally with those two
      vars set, or a future session with them available.
- [x] No reference to Guerrilla Mail, `api.guerrillamail.com`, or `temp-inbox.ts`
      remains anywhere in `apps/chrono-web`.
- [x] `pnpm --filter @agora/chrono-web typecheck` passes.

**Step 1 findings (live-verified via `mcp__mailtrap__*` this session, correcting the
plan's assumed shape):** the actual Email Sandbox API has no `account_id` — only
`GET https://mailtrap.io/api/sandboxes/{sandbox_id}/messages` (search matches
`subject`/`to_email`/`to_name`) and
`GET .../sandboxes/{sandbox_id}/messages/{message_id}/body.html`, both authed via
`Api-Token: <token>`. `sandbox_id` is the same id as the inbox (`277668` for
`chrono`). Confirmed against `docs.mailtrap.io/developers/email-sandbox/messages.md`
and by a live `get-sandbox-messages`/`get-sandbox-message-html` round trip. So
`MAILTRAP_ACCOUNT_ID` (Key decision 3, above) is unnecessary and was not added —
only `MAILTRAP_API_TOKEN`/`MAILTRAP_TEST_INBOX_ID`, as `.env.example` now reflects.

## Verification commands

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web e2e -- e2e/tests/settings/members-invite.spec.ts`
  (dev servers already running per `apps/chrono-web/playwright.config.ts`'s own
  header comment; start chrono-api with the mailtrap env vars for this run)

## Out of scope

- `apps/agora-web`'s own `temp-inbox.ts` / `members-invite.spec.ts` — left on
  Guerrilla Mail, by the developer's explicit scope choice.
- The pre-existing `:3000` vs `:3002` port drift already visible in this spec file
  (chrono-web's other specs are mid-migration to `:3002` per the in-flight
  `customers-members-merge` work; unrelated to this change — do not fix here).
- Cleaning/expiring old Mailtrap sandbox messages — correlation is by exact unique
  recipient email, so stale messages can't cause a false match. A future CI-hygiene
  nicety, not needed now.
- Any change to `packages/agora` (covered entirely by the companion Plan A).

## Execution start point

Read `apps/chrono-web/e2e/utils/temp-inbox.ts` (the file being replaced) and
`apps/chrono-web/e2e/tests/settings/members-invite.spec.ts` in full first, then
confirm the live Mailtrap API shape (step 1) before writing any code.
