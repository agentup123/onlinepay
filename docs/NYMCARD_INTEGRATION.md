# NymCard integration

All issuer calls go through one interface, `NymCardClient` (`apps/api/src/nymcard/nymcard.types.ts`):

| Implementation      | When                                 | File              |
| ------------------- | ------------------------------------ | ----------------- |
| `NymCardMockClient` | `NYMCARD_MODE=mock` (dev, tests, CI) | `nymcard.mock.ts` |
| `NymCardHttpClient` | `sandbox` / `production`             | `nymcard.http.ts` |

The rest of the app never sees NymCard's request/response shapes, so finishing the integration
only touches `nymcard.http.ts` and `nymcard.webhook.ts`.

## Not yet verified (`TODO(nymcard-docs)`)

None of the HTTP details below have been checked against the real API. Fill them in from
NymCard's sandbox documentation / your onboarding pack:

| #   | Item                                                                                                                  | Where                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1   | Base URLs (sandbox, production)                                                                                       | `.env` `NYMCARD_BASE_URL`                                     |
| 2   | Auth scheme (API key header vs OAuth client-credentials + token refresh)                                              | `NymCardHttpClient.request`                                   |
| 3   | Create cardholder endpoint + required KYC fields                                                                      | `createCardholder`                                            |
| 4   | Issue virtual card endpoint, product id, idempotency support                                                          | `createVirtualCard`                                           |
| 5   | Card object fields (`last4`, expiry, status values, balance)                                                          | `mapCard`                                                     |
| 6   | Status change endpoint and status names (freeze/unfreeze/terminate)                                                   | `setCardStatus`                                               |
| 7   | Spending-limit / velocity-control endpoint                                                                            | `setSpendingLimit`                                            |
| 8   | Load / unload funds endpoints (or account-to-card transfers)                                                          | `loadFunds`, `unloadFunds`                                    |
| 9   | **Secure card display** (iframe/SDK URL or token) and its origin for CSP                                              | `createSecureDisplaySession`, `NYMCARD_SECURE_DISPLAY_ORIGIN` |
| 10  | Transactions list endpoint + pagination                                                                               | `listTransactions`                                            |
| 11  | Webhook signature header, algorithm, timestamp/replay protection                                                      | `verifyNymCardSignature`, `NYMCARD_WEBHOOK_SIGNATURE_HEADER`  |
| 12  | Webhook event names and payload fields                                                                                | `parseNymCardEvent`                                           |
| 13  | Error codes worth mapping to user messages (insufficient funds, card blocked…)                                        | `NymCardHttpClient.request`                                   |
| 15  | Idempotency: a repeated key should replay the original result (incl. rejections). Defence in depth only — see item 18 | `request`, DECISIONS D9                                       |
| 16  | Whether unloads are allowed on frozen cards (we fall back to reactivating briefly)                                    | `CardsService.unloadForCancellation`                          |
| 17  | Settlement/funding reports to reconcile loads/unloads against our wallet ledger                                       | `ReconciliationService`                                       |
| 18  | **Look up a load/unload by our `reference`** (sent in the load/unload body) — endpoint, filter and status values      | `findFundsOperation`                                          |
| 14  | IP allow-listing of our egress IPs / their webhook source IPs                                                         | infra                                                         |

## Webhook pipeline

```
NymCard ──POST /webhooks/nymcard──▶ verify signature ──▶ WebhookEvent (unique provider+eventId)
                                                       └─▶ BullMQ "nymcard-events" (jobId = row id)
worker ──▶ parseNymCardEvent ──▶ CardEventsService.apply ──▶ CardTransaction upsert
                                                         ├─▶ card balance/status sync
                                                         ├─▶ notifications (txn, decline)
                                                         └─▶ monitoring rules → SuspiciousActivityFlag
```

- Duplicate deliveries return `200 {duplicate:true}` and are not processed twice. If the original
  delivery was stored but never enqueued (Redis down), the redelivery re-enqueues it; the worker's
  `resume-operations` job also sweeps events that no worker picked up within 5 minutes.
- The worker processes the **normalised** event captured from the raw body at ingest
  (`WebhookEvent.normalized`); the stored `payload` is redacted and only kept for support/audit.
- Out-of-order events: a transaction never moves back to pending and reversed/declined ones are
  final; card status events older than `Card.statusChangedAt` and balances older than
  `Card.balanceAsOf` are ignored. Merchant refunds are stored as their own rows.
- A card cancelled by the issuer while it still holds money raises an
  `ISSUER_CANCELLED_WITH_BALANCE` flag (we can no longer sweep it).
- Events for a card we don't know yet throw, so the job retries (8 attempts, exponential backoff).
- Jobs that exhaust retries stay unprocessed and appear in Admin → Webhooks with a Retry button.

## Reconciliation

Nightly at 02:00 Asia/Dubai the worker compares every non-cancelled card's status and balance with
NymCard, repairs drift and writes `reconciliation.card_drift` audit entries. Cards with an operation
in flight are skipped. It also checks every wallet's cached balance against the sum of its ledger
(`reconciliation.wallet_drift`, never auto-corrected) and marks checkouts abandoned for 24 h as
`FAILED`. Unrecognised NymCard card statuses are treated as an error, never mapped to `CANCELLED`.

Every 5 minutes, `resume-operations` finishes interrupted issuances, fundings, cancellations and
refunds (DECISIONS D9).

## Go-live checklist

1. Fill every item in the table above; remove the `TODO(nymcard-docs)` markers.
2. Run the e2e flow with `NYMCARD_MODE=sandbox`.
3. Sandbox safety test for interrupted operations (items 15 and 18), with `NYMCARD_MODE=sandbox`:
   - Load a card with a fixed idempotency key, then send the identical request again: the card
     must be loaded **once** and the second response must match the first.
   - Load a card, then call `findFundsOperation(cardId, reference)`: it must return the load.
     Call it with an unused reference: it must return `null`.
   - Repeat both for unloads.
   - Ask NymCard in writing how long idempotency keys are retained.
4. Register the production webhook URL and secret; confirm signature verification with a test event.
5. Confirm settlement/funding account set-up and daily settlement reports with NymCard finance.
