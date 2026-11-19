import { expect, test, type APIRequestContext } from '@playwright/test';

const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

/** Reads the most recent 6-digit OTP sent to an address via Mailpit's API. */
async function latestEmailOtp(request: APIRequestContext, to: string): Promise<string> {
  for (let i = 0; i < 20; i++) {
    const res = await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    const body = await res.json();
    const msg = body.messages?.[0];
    if (msg) {
      const full = await (await request.get(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
      const code = String(full.Text ?? '').match(/\b(\d{6})\b/)?.[1];
      if (code) return code;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`No OTP email for ${to}`);
}

/**
 * Sign up → KYC (mock auto-approve) → buy bundle (mock gateway) → create card → freeze → cancel.
 * In dev the console SMS provider mirrors every SMS to Mailpit as sms+<digits>@onlinepay.local,
 * so both OTPs can be read from Mailpit.
 */
test('consumer core flow', async ({ page, request }) => {
  const stamp = Date.now();
  const email = `e2e+${stamp}@onlinepay.local`;
  const phone = `050${String(stamp).slice(-7)}`;
  const phoneMailbox = `sms+971${phone.slice(1)}@onlinepay.local`;

  await page.goto('/en/signup');
  await page.getByLabel('Full name').fill('E2E Tester');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('UAE mobile number').fill(phone);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Email code').fill(await latestEmailOtp(request, email));
  await page.getByLabel('SMS code').fill(await latestEmailOtp(request, phoneMailbox));
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page).toHaveURL(/\/en\/kyc/);
  await page.getByLabel(/Nationality/).fill('AE');
  await page.getByLabel('Date of birth').fill('1990-01-01');
  await page.getByRole('button', { name: 'Start verification' }).click();
  await expect(page.getByTestId('kyc-status')).toContainText("You're verified");

  await page.goto('/en/dashboard');
  await page.getByTestId('buy-bundle').click();
  await page.getByTestId('pay').click();
  await page.getByTestId('mock-pay-success').click();
  await expect(page.getByTestId('checkout-result')).toContainText('Payment successful', { timeout: 30_000 });

  await page.goto('/en/dashboard');
  await expect(page.getByTestId('quota')).toContainText('30 of 30');
  await page.getByLabel('Card name').fill('Netflix');
  await page.getByTestId('create-card').click();
  await expect(page.getByTestId('quota')).toContainText('29 of 30');

  await page.getByTestId('card-tile').first().click();
  await page.getByTestId('freeze').click();
  await expect(page.getByTestId('unfreeze')).toBeVisible();

  page.once('dialog', (d) => d.accept());
  await page.getByTestId('cancel-card').click();
  await expect(page.getByText('Cancelled').first()).toBeVisible();
});
