# Architecture

## Processes

| Process | Code | Responsibilities |
| --- | --- | --- |
| Web | `apps/web` | Consumer UI (EN/AR, RTL). Proxies `/api/*` to the API so cookies are first-party. |
| Admin | `apps/admin` | Internal UI. Separate origin and cookie, password + TOTP. |
| API | `apps/api/src/main.ts` | HTTP API, webhook ingestion, all NymCard and gateway calls. |
| Worker | `apps/api/src/worker.ts` | Webhook processing, notifications, monitoring, nightly reconciliation, cleanup. |
| PostgreSQL | Prisma (`packages/db`) | System of record. |
| Redis | BullMQ | Job queues; mock-NymCard state in dev. |

## Main flows

### Sign-up and KYC
1. `POST /auth/signup` creates a pending user and sends email + SMS OTPs.
2. `POST /auth/signup/verify` checks both, activates the account, creates the wallet, sets the session cookie.
3. `POST /kyc` submits the KYC provider reference. On approval the user is registered as a NymCard cardholder.

### Buying the bundle
1. `POST /payments/bundle/checkout` (Idempotency-Key) creates a `PENDING` purchase priced with VAT and returns the gateway's hosted-page URL.
2. The gateway webhook (`payment.captured`) is stored and processed by the worker: amount check → `PAID` → VAT invoice → notification.
3. The browser's return page polls `GET /payments/:id` until it is `PAID`.

### Cards
- **Create:** KYC approved + quota left (checked under a per-user advisory lock) → NymCard issue → `Card` row.
- **Fund:** wallet debit (atomic, idempotent) → NymCard load; on failure the debit is reversed.
- **Reveal:** API returns a short-lived NymCard secure-display URL; the browser shows it in an iframe.
- **Freeze / unfreeze / cancel:** state machine in `packages/shared/src/card-state.ts`; cancel sweeps the balance back to the wallet first.
- **Transactions:** come only from NymCard webhooks (inbox → worker → `CardTransaction`).

## Data model

See `packages/db/prisma/schema.prisma`. Highlights:

- Money columns are integer fils.
- `WalletLedgerEntry`, `AuditLog`, `WebhookEvent` are append-only.
- `IdempotencyRecord` stores first responses for retried requests.
- `Card` holds only NymCard id, label, last4, expiry, status, limit and a cached balance.

## Error handling conventions

- API errors return `{ statusCode, code, ... }`; the web app maps `code` to translated messages (`messages/*.json → errors`).
- External calls have timeouts and never log response bodies.
- Anything that moves money is idempotent and audit-logged.
