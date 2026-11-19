# Decisions

Each decision is configurable. Items marked **Pending founder confirmation** use a safe default
until confirmed.

## D1 — Bundle is a one-time purchase · Pending founder confirmation

`BUNDLE_MODE=one_time`. A user can buy more bundles; quotas add up.
`subscription` is reserved: it needs recurring billing (gateway card-on-file / payment
instruments), proration rules, and what happens to active cards when a subscription lapses.
The API returns `501 SUBSCRIPTIONS_NOT_IMPLEMENTED` if switched on today.

## D2 — Cancelled cards still use a slot · Pending founder confirmation

`CANCELLED_CARDS_COUNT_AGAINST_BUNDLE=true`. "30 cards" means 30 cards issued. Each issued card
costs us with NymCard, so freeing slots on cancellation would make the bundle unlimited.
Set to `false` to let users replace cancelled cards (quota = cards not cancelled).

## D3 — Remaining balance on a cancelled card goes to the wallet · Pending founder confirmation

`CANCELLED_CARD_BALANCE_DESTINATION=wallet`. On cancel we unload the card's balance at NymCard
and credit the user's OnlinePay wallet. `source` (refund to the original payment method)
is stubbed: it needs a mapping from card loads to gateway payments and partial refunds.

## D4 — Wallet + card funding model

Users top up a **wallet** through the gateway, then move money onto individual cards. This keeps
one payment per top-up (fewer gateway fees) and makes cancellation refunds simple.
**Confirm with NymCard** whether funds must sit in a NymCard-held account/wallet rather than an
OnlinePay ledger — this affects whether OnlinePay holds customer funds (see COMPLIANCE.md).

## D5 — Passwordless login

Sign-up verifies **both** email and phone with OTPs. Login uses an SMS OTP to the verified phone.
No passwords to leak or reset. Sessions: opaque random token in an httpOnly, SameSite=Lax cookie,
stored hashed, 7-day lifetime, revocable.

## D6 — API and worker share one codebase

`apps/worker` from the original plan lives in `apps/api/src/worker.ts`: it reuses every service and
is deployed as a second process from the same build.

## D7 — Invoices are printable HTML

Invoices are rendered as a printable tax-invoice page ("Print / save as PDF"). Add server-side PDF
generation (and emailing) later if the accountant needs stored PDFs.

## D8 — No VAT on wallet top-ups

Top-ups are stored value, not a supply, so no VAT is charged; VAT applies to the bundle (the
service fee). **Confirm with a UAE tax advisor.**

## D9 — Money-moving calls are persisted operations

Card issuance, card funding, card cancellation and refunds each write a row (`CardIssuance`,
`CardFunding`, `CardCancellation`, `Refund`) **before** calling NymCard or the gateway, and use an
issuer/gateway idempotency key derived from that row's id. Outcomes:

- **Definite rejection** (4xx except 408/409/425/429) → `FAILED`, compensate exactly once (e.g.
  return the wallet debit).
- **Unknown** (timeout, network error, 5xx, ambiguous 4xx) → `UNKNOWN`, never compensated. The
  client's retry with the same `Idempotency-Key`, or the worker's `resume-operations` job (every
  5 minutes), repeats the call with the same issuer key.

Before resending a NymCard load/unload that may already have happened (any attempt after the
first), the worker looks it up by the reference we attach to every load/unload
(`findFundsOperation`). Found → recorded as done; not found → resent with the same key; lookup
failed → stays `UNKNOWN` (never resent blind), with a `FUNDING_UNRESOLVED` flag after 10 tries.
So correctness no longer depends on NymCard's idempotency handling alone; the gateway still relies
on Checkout.com's idempotency keys. If a load ever succeeds after we marked it `FAILED`, a
`FUNDING_INCONSISTENT` flag is raised for ops instead of silently creating money.

## D10 — One lock per card

Fund, cancel and freeze take a Postgres advisory lock per card (`card:<id>`) for their DB step. A
card with a cancellation in progress accepts no other change; cancellation waits until no funding
is in flight.

## D11 — Freezes record who applied them

`Card.frozenBy` is `USER` or `ADMIN`. A cardholder cannot unfreeze or cancel an admin
(compliance) freeze — cancelling would sweep the frozen balance into the wallet. Suspending a user
freezes all their cards as an admin freeze.

## D12 — 30 cards for 30.00 AED, VAT included · Decided

The customer pays exactly **30.00 AED all-in**. Bundle prices are stored VAT-exclusive, so
`CARDS_30` is stored as 2857 fils (28.57 AED) + 143 fils VAT (1.43 AED) = 3000 fils. The constant
lives in `packages/shared/src/vat.ts` (`CARDS_30_PRICE_EXCL_VAT_FILS`); migration
`20261119160000_bundle_price_vat_inclusive` updates existing databases. Prices are always shown
VAT-inclusive, with the VAT amount underneath.

## D13 — Stored-value limits

Top-ups are refused if the wallet would exceed `WALLET_MAX_BALANCE_FILS` (default 15,000 AED) or
30-day top-ups would exceed `WALLET_TOPUP_30D_LIMIT_FILS` (default 30,000 AED). Top-ups at or above
`MONITOR_HIGH_AMOUNT_FILS` raise a `HIGH_TOPUP` flag. **Agree the values with your MLRO and
NymCard.**
