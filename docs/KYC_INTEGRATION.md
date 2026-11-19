# Plugging in the KYC and screening vendor

OnlinePay ships with **mock** identity-verification and sanctions/PEP screening providers. The API
refuses to start in production while either is `mock`, so integrating the vendor NymCard approves
is a go-live blocker. The rest of the flow (screening gate, compliance review, re-screening,
admin UI) is already built and vendor-neutral.

## 1. Agree the vendor with NymCard

Ask NymCard (programme manager onboarding) for:

- Which KYC/IDV providers satisfy their cardholder onboarding rules, or whether they offer KYC as
  part of the programme.
- Whether they require you to run sanctions/PEP screening yourself, or screen cardholders
  themselves (you may still need your own screening under your AML programme — check with your
  MLRO).
- Which identity fields they need on `createCardholder` and whether they want the provider's
  verification reference.

## 2. Implement the adapters

Both interfaces live in `apps/api/src/kyc/kyc.provider.ts`.

```ts
export interface KycProvider {
  readonly name: string; // stored on each KycApplication, e.g. 'sumsub'
  submit(applicant: KycApplicant, input: KycSubmitInput): Promise<KycSubmission>;
  verifyWebhook?(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  parseWebhook?(body: Record<string, unknown>): KycWebhookDecision | null;
}

export interface ScreeningProvider {
  readonly name: string;
  screen(subject: ScreeningSubject): Promise<ScreeningResult>; // CLEAR | POTENTIAL_MATCH | ERROR
}
```

Guidelines:

- **Never store document images or ID numbers.** The vendor's web SDK captures them; `submit`
  receives only `providerCaptureRef` (the vendor's applicant/session id from the SDK).
- Return `verified.dateOfBirth` / `verified.nationality` from the document whenever the vendor
  provides them — they replace what the user typed.
- Most vendors decide asynchronously: return `PENDING` from `submit` and implement
  `verifyWebhook` + `parseWebhook`. Decisions arrive at `POST /webhooks/kyc` (signature-checked,
  no cookie needed) and go through the same gate as everything else.
- `screen` must return `ERROR` (or throw) when the vendor can't give an answer — **never `CLEAR`
  by default**. If the KYC vendor also screens, one class can implement both interfaces.
- Map the vendor's HTTP errors carefully and add a timeout (see `nymcard.http.ts` for the
  pattern).

## 3. Wire it up

1. Add the vendor's value to `KYC_PROVIDER` / `SCREENING_PROVIDER` in `apps/api/src/config/env.ts`
   with any credentials it needs (validated at boot).
2. Add a `case` returning your adapter in `kycProviderFactory` / `screeningProviderFactory`
   in `apps/api/src/kyc/kyc.module.ts`.
3. Point the web KYC page at the vendor's SDK so it produces `providerCaptureRef`.
4. Register `https://<api>/webhooks/kyc` in the vendor's dashboard.
5. Add unit tests for `parseWebhook` and the signature check with real sample payloads from the
   vendor's docs.

## How decisions flow

```
submit / vendor webhook ──▶ applyDecision
   REJECTED ─────────────▶ REJECTED (customer notified)
   APPROVED ─▶ age ≥ 18? ── no ─▶ REJECTED
                  │ yes
                  ▼
           sanctions/PEP screening
             CLEAR ─────────────▶ APPROVED ─▶ NymCard cardholder created
             POTENTIAL_MATCH ───▶ PENDING + SCREENING_MATCH flag ─▶ compliance review
             ERROR ─────────────▶ PENDING + SCREENING_ERROR flag ─▶ retried on approval
```

- Compliance can approve a potential match only with a written false-positive disposition
  (min. 10 characters); it is recorded in the audit log.
- Approval is impossible while screening is unavailable.
- Approved customers are re-screened nightly once their last screening is older than 30 days
  (`RESCREEN_AFTER_MS`); new hits raise a `SCREENING_MATCH` flag. Vendors with ongoing
  monitoring can also push changes via the webhook.
- Only a customer's latest application counts, so compliance can revoke an approval; suspend the
  user as well to freeze existing cards.
