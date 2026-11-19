## What

## Why

## Checklist

- [ ] No PAN, CVV, OTPs, tokens or ID document data are stored or logged
- [ ] Money is handled in integer fils (no floats)
- [ ] Money-moving endpoints use idempotency keys
- [ ] New card/money/admin actions write an audit log entry
- [ ] User-facing strings added in both `en.json` and `ar.json`
- [ ] Tests added/updated; `pnpm lint typecheck test` pass
