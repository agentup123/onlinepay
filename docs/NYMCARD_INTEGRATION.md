# NymCard integration

All issuer calls go through one interface, `NymCardClient` (`apps/api/src/nymcard/nymcard.types.ts`):

| Implementation | When | File |
| --- | --- | --- |
| `NymCardMockClient` | `NYMCARD_MODE=mock` (dev, tests, CI) | `nymcard.mock.ts` |
| `NymCardHttpClient` | `sandbox` / `production` | `nymcard.http.ts` |

The rest of the app never sees NymCard's request/response shapes, so finishing the integration
only touches `nymcard.http.ts` and `nymcard.webhook.ts`.

## Not yet verified (`TODO(nymcard-docs)`)

None of the HTTP details below have been checked against the real API. Fill them in from
NymCard's sandbox documentation / your onboarding pack:

| # | Item | Where |
| --- | --- | --- |
| 1 | Base URLs (sandbox, production) | `.env` `NYMCARD_BASE_URL` |
| 2 | Auth scheme (API key header vs OAuth client-credentials + token refresh) | `NymCardHttpClient.request` |
| 3 | Create cardholder endpoint + required KYC fields | `createCardholder` |
| 4 | Issue virtual card endpoint, product id, idempotency support | `createVirtualCard` |
| 5 | Card object fields (`last4`, expiry, status values, balance) | `mapCard` |
| 6 | Status change endpoint and status names (freeze/unfreeze/terminate) | `setCardStatus` |
| 7 | Spending-limit / velocity-control endpoint | `setSpendingLimit` |
| 8 | Load / unload funds endpoints (or account-to-card transfers) | `loadFunds`, `unloadFunds` |
| 9 | **Secure card display** (iframe/SDK URL or token) and its origin for CSP | `createSecureDisplaySession`, `NYMCARD_SECURE_DISPLAY_ORIGIN` |
| 10 | Transactions list endpoint + pagination | `listTransactions` |
| 11 | Webhook signature header, algorithm, timestamp/replay protection | `verifyNymCardSignature`, `NYMCARD_WEBHOOK_SIGNATURE_HEADER` |
| 12 | Webhook event names and payload fields | `parseNymCardEvent` |
| 13 | Error codes worth mapping to user messages (insufficient funds, card blocked…) | `NymCardHttpClient.request` |
| 14 | IP allow-listing of our egress IPs / their webhook source IPs | infra |

## Webhook pipeline

```
NymCard ──POST /webhooks/nymcard──▶ verify signature ──▶ WebhookEvent (unique provider+eventId)
                                                       └─▶ BullMQ "nymcard-events" (jobId = row id)
worker ──▶ parseNymCardEvent ──▶ CardEventsService.apply ──▶ CardTransaction upsert
                                                         ├─▶ card balance/status sync
                                                         ├─▶ notifications (txn, decline)
                                                         └─▶ monitoring rules → SuspiciousActivityFlag
```

- Duplicate deliveries return `200 {duplicate:true}` and are not processed twice.
- Out-of-order events: a settled/reversed transaction is never moved back to pending.
- Events for a card we don't know yet throw, so the job retries (8 attempts, exponential backoff).
- Jobs that exhaust retries stay unprocessed and appear in Admin → Webhooks with a Retry button.

## Reconciliation

Nightly at 02:00 Asia/Dubai the worker compares every non-cancelled card's status and balance with
NymCard, repairs drift and writes `reconciliation.card_drift` audit entries.

## Go-live checklist

1. Fill every item in the table above; remove the `TODO(nymcard-docs)` markers.
2. Run the e2e flow with `NYMCARD_MODE=sandbox`.
3. Register the production webhook URL and secret; confirm signature verification with a test event.
4. Confirm settlement/funding account set-up and daily settlement reports with NymCard finance.
