# Compliance & security notes

> Not legal advice. Items marked **⚖ needs review** must be confirmed with UAE counsel, your
> NymCard programme team and (for tax) a UAE tax advisor before launch.

## Regulatory position

- **⚖ needs review — licensing.** OnlinePay acts as a programme manager; cards are issued by
  NymCard's licensed issuing partner. Confirm with NymCard and counsel whether OnlinePay's
  activities (selling bundles, holding a wallet balance, marketing cards) need their own CBUAE
  licence or registration, or are fully covered under NymCard's programme — in particular under
  the CBUAE Stored Value Facilities and Retail Payment Services regulations.
- **⚖ needs review — the wallet.** If OnlinePay holds customer money in its own ledger before it
  is loaded onto cards, that may count as holding stored value. A safer design may be to hold
  balances in a NymCard account per user. See `docs/DECISIONS.md` D4.
- **⚖ needs review — consumer protection.** Clear fees, cancellation and refund terms, complaint
  handling and the CBUAE consumer protection standards. Legal pages are placeholders.

## KYC / AML

- Identity verification (Emirates ID / passport) is required before buying or issuing cards.
  Document images stay with the KYC provider; we store only status, provider reference,
  document type, nationality and date of birth.
- **⚖ needs review:** which KYC provider satisfies NymCard's onboarding rules; sanctions/PEP
  screening (at onboarding and ongoing); risk-rating; age 18+ enforcement; re-verification
  when documents expire.
- Transaction monitoring rules (`apps/api/src/monitoring/monitoring.rules.ts`): high amount,
  velocity, decline bursts, risky MCCs. Thresholds are placeholders — agree them with your
  **MLRO**. Escalated flags may need a Suspicious Transaction Report via **goAML** (UAE FIU).
- Record keeping: AML rules generally require keeping customer and transaction records for
  at least 5 years — do not delete them on account closure. **⚖ needs review.**

## Data protection (UAE PDPL)

- Collect the minimum: name, email, phone, KYC outcome, transactions.
- Never stored: PAN, CVV, PIN, ID document images or numbers, OTP codes in plain text.
- Host data in the UAE where required by NymCard/CBUAE (data residency **⚖ needs review**).
- Admin viewing of a user profile is itself audit-logged.
- Privacy notice, data subject requests (access/correction/deletion vs AML retention), breach
  notification process.

## Tax

- 5% VAT on the bundle; invoices show seller TRN, invoice number, date, subtotal, VAT, total.
- Set `COMPANY_TRN` once registered with the FTA.
- No VAT on wallet top-ups (stored value). **⚖ needs review.**

## PCI-DSS

- Card entry happens only on the gateway's hosted page → aim for **SAQ-A**.
- Card details shown only through NymCard's hosted secure display iframe; our servers never
  receive them. CSP limits iframe sources (`NYMCARD_SECURE_DISPLAY_ORIGIN`).
- Redacting logger + shared `redact()` strip PAN-like numbers, Emirates IDs and sensitive keys
  from logs and stored webhook payloads.

## Application security controls in this codebase

| Control | Where |
| --- | --- |
| Passwordless OTP auth, hashed OTPs (HMAC + pepper), 5-min expiry, 5 attempts, send limits | `auth/otp.service.ts` |
| Opaque session tokens stored as SHA-256, httpOnly + SameSite cookies, revocation | `auth/` |
| Admin: bcrypt password + TOTP, 8-hour sessions, SameSite=Strict, role-based access | `admin/admin-auth.ts` |
| CSRF: Origin/Referer check on all mutating cookie routes | `common/origin.middleware.ts` |
| Rate limiting (global + stricter on auth/card actions) | `@nestjs/throttler` |
| Idempotency keys on purchases, card create/fund/cancel | `common/idempotency.interceptor.ts` |
| Atomic wallet ledger, never negative, idempotent entries | `wallet/wallet.service.ts` |
| Per-user advisory lock prevents exceeding bundle quota under concurrency | `cards/cards.service.ts` |
| Signed, idempotent webhooks; amount check before granting value | `webhooks/`, `payments/payments.service.ts` |
| Audit log for every card, money, KYC and admin action | `common/audit.service.ts` |
| Security headers (helmet, CSP, HSTS), mock providers blocked in production | `main.ts`, `next.config.mjs`, `config/env.ts` |

## Before production

- [ ] Encrypt admin TOTP secrets at rest (KMS) and move secrets to a secrets manager
- [ ] Put the admin app behind SSO/VPN/IP allow-list
- [ ] Penetration test; dependency scanning (Dependabot / `pnpm audit`)
- [ ] Centralised logging with retention, alerting on webhook failures and flag spikes
- [ ] Backups and restore drill; incident response and breach notification runbook
- [ ] Real SMS provider with a TDRA-registered sender ID
