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
