# Member wallet top-up: preset amounts + PayMongo branding

**App:** `chrono`

**Sessions:**
- Planning: `plan-folder-taxonomy-refactor [6a865f]`
- Audit: `plan-auditor` subagent — APPROVED WITH CONDITIONS. All factual claims
  (line numbers, imports, bounds, e2e specs, no-logo-asset claim) verified correct.
  2 conditions applied below: the Badge/DialogTitle placement is now literal JSX
  (was prose, and a bare Badge sibling in `DialogHeader` would have stacked below
  the title, not next to it); the preset-buttons `Row` now has `wrap` to avoid
  horizontal overflow on narrow viewports (this file's own `admin/staff/page.tsx`
  precedent uses `wrap` for the same reason).

## Context / why

The member portal wallet page (`{tenant}.chrono2.izur.com.ph/member/wallet`) already
has a working PayMongo-backed online top-up flow — built under
`.ai/plans/chrono/archive/member-credit-purchase/README.md` and hardened under
`.ai/plans/chrono/archive/member-wallet-operation-hardening/README.md`. Confirmed by
direct inspection of
`apps/chrono-web/src/app/(member-area)/member/wallet/page.tsx` and
`apps/chrono-web/src/lib/member/payments.ts`:

- "Top up online" → dialog → free-text **custom amount only** (₱20–₱10,000 bounds,
  mirrored from `MIN_WALLET_TOPUP_AMOUNT`/`MAX_WALLET_TOPUP_AMOUNT` in
  `apps/chrono-api/src/modules/payment/contracts.ts`) → `createCheckout({purpose:
  "wallet_topup", amount})` → redirect to PayMongo hosted checkout (GCash/card) →
  webhook-only fulfilment, polled return banner.
- The dialog's only payment-provider copy today is generic: "Pay online with GCash or
  a card." No PayMongo name/branding shown anywhere on this page.
- "Buy promos and pay online" already exists too, as **credit-pack purchases** on
  `/member/promos` / `/member/promos/[id]` (`purpose: "credit_purchase"`, same
  `createCheckout` client) — confirmed with the developer this is the intended flow;
  no changes to that page are in scope for this plan.

Confirmed with the developer that the actual gap is two small, additive UI changes to
the **existing** top-up dialog only:

1. Quick-select preset amount buttons (₱50 / ₱100 / ₱200 / ₱500) alongside the
   existing custom-amount input.
2. Visible PayMongo branding on that same dialog.

This is a **UI-only** change to one file. No schema, contracts, `/rpc`/`/portal`
route, or webhook change — the existing `createCheckout`/`MIN`/`MAX` validation
already covers every preset value (all four presets fall inside ₱20–₱10,000), and the
existing e2e specs (`apps/chrono-web/e2e/tests/member/online-checkout.spec.ts`,
`.../member/wallet-operation-hardening.spec.ts`) only assert `topup-button`/API-level
behavior, not the dialog's internal amount-entry markup, so they need no changes.

**No PayMongo logo/SVG asset exists anywhere in this repo** — every existing mention
(`apps/chrono-web/.../settings/integrations/page.tsx`, the apex pricing page) is plain
text ("PayMongo"), never an image. Branding here follows that same precedent: a text
label, not a logo image (no asset to source, and none should be fetched from an
external URL into this repo for a trademarked brand mark without the developer
supplying it).

## Pass 1 — Workflow analysis

**Actor:** a tenant member (`tenantMember`) with a member-portal session, on
`/member/wallet`. No role/permission gate change — this is purely additive UI on an
already-gated (`memberMiddleware()`) page.

**Happy path (unchanged, just richer UI):** open "Top up online" → click a preset
button (or type a custom amount) → amount populates the same input → "Continue to
payment" → PayMongo hosted checkout → webhook fulfils → return banner reflects
status. No new failure cases introduced — presets are just pre-filled values subject
to the exact same client + server validation as a manually typed amount.

## Pass 2 — Technical design

Single phase, one file: `apps/chrono-web/src/app/(member-area)/member/wallet/page.tsx`.

1. **Preset amounts.** Add a `PRESET_TOPUP_AMOUNTS = ["50.00", "100.00", "200.00",
   "500.00"] as const` constant next to the existing `MIN_TOPUP_AMOUNT`/
   `MAX_TOPUP_AMOUNT` constants (~line 53), with the same "mirrors the server, kept
   as a display constant" comment convention already used there.
2. In the top-up `Dialog` (~line 386, the `Stack gap={2}` holding the `Label`/`Input`
   pair), add a `Row gap={2}` of one `Button` per preset **above** the existing
   `Input`, reusing the `Button`/`Row` imports already present in this file (no new
   `agora/ui` primitive — per `.ai/rules/component-first-ui.md`, reuse over
   invention):
   ```tsx
   <Row gap={2} wrap>
     {PRESET_TOPUP_AMOUNTS.map((amt) => (
       <Button
         key={amt}
         type="button"
         size="sm"
         variant={topupAmount === amt ? "default" : "outline"}
         onClick={() => {
           setTopupAmount(amt);
           setTopupError(null);
         }}
         data-testid={`topup-preset-${amt}`}
       >
         {formatCurrency(amt, gateway?.currency)}
       </Button>
     ))}
   </Row>
   ```
   Clicking a preset just populates `topupAmount` (the same state the `Input` already
   binds to) — the `Input` stays fully editable for a custom amount afterward, and
   `onSubmitTopup`'s existing bounds check covers both paths identically. No new
   state, no change to `onSubmitTopup`.
3. **PayMongo branding.** Two small copy/markup additions, no new component:
   - `DialogDescription` (~line 382-384): change "Pay online with GCash or a card.
     You'll be redirected to a secure payment page." to name PayMongo explicitly,
     e.g. "Pay online with GCash or a card via PayMongo. You'll be redirected to a
     secure PayMongo payment page."
   - `DialogTitle` (~line 381) currently reads `<DialogTitle>Top up your wallet</DialogTitle>`
     as the sole child of `DialogHeader` — a `<div className="mb-4 space-y-1.5">`
     (vertically stacked, not a flex row: `packages/agora/src/presentation/ui/components/dialog.tsx:52-57`).
     A bare `Badge` sibling here would stack *below* the title, not sit next to it.
     Wrap title + badge in a `Row` instead (`Row`/`Badge` both already imported in
     this file), replacing that one line:
     ```tsx
     <Row items="center" gap={2}>
       <DialogTitle>Top up your wallet</DialogTitle>
       <Badge variant="outline">Secured by PayMongo</Badge>
     </Row>
     ```
     This keeps `DialogHeader`'s existing `DialogDescription` as the next sibling,
     unchanged in position — only its own copy changes per the bullet above.

## Files to update

- `apps/chrono-web/src/app/(member-area)/member/wallet/page.tsx` (only file)

## Acceptance criteria

- [ ] Wallet top-up dialog shows four preset buttons (₱50/₱100/₱200/₱500) above the
      custom-amount input; clicking one fills the input with that value and the user
      can still edit it to a different amount before continuing.
- [ ] The dialog visibly names PayMongo (badge + updated description copy).
- [ ] `pnpm --filter @agora/chrono-web typecheck` passes.
- [ ] `apps/chrono-web/e2e/tests/member/online-checkout.spec.ts` and
      `apps/chrono-web/e2e/tests/member/wallet-operation-hardening.spec.ts` still
      pass unchanged.

## Verification commands

- `pnpm --filter @agora/chrono-web typecheck`
- `pnpm --filter @agora/chrono-web e2e -- e2e/tests/member/online-checkout.spec.ts`
- `pnpm --filter @agora/chrono-web e2e -- e2e/tests/member/wallet-operation-hardening.spec.ts`

## Out of scope

- Any change to `/member/promos` or the credit-purchase ("Buy online") flow —
  confirmed with the developer this already covers "buy promos and pay online."
- Any schema, contracts, `/rpc`/`/portal` route, or webhook change — none needed.
- Sourcing/adding an actual PayMongo logo image asset — no such asset exists in the
  repo today; branding here is text-only. If the developer wants an actual logo
  image, that needs the asset supplied first (a separate, follow-up decision).
- Applying the same PayMongo branding to the credit-purchase "Buy online" surface on
  `/member/promos/[id]` — not requested; a natural follow-up if wanted later.

## Execution start point

Read `apps/chrono-web/src/app/(member-area)/member/wallet/page.tsx` in full before
editing — confirm exact current line numbers for the constants block and the
`Dialog` JSX haven't shifted, then make the edits above in that one file.
