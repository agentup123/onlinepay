import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

// Load the monorepo root .env first, then any app-local .env.
loadDotenv({ path: path.resolve(__dirname, '../../../../.env') });
loadDotenv();

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().default(4000),
  API_URL: z.string().url().default('http://localhost:4000'),
  WEB_URL: z.string().url().default('http://localhost:3000'),
  ADMIN_URL: z.string().url().default('http://localhost:3001'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default('redis://localhost:6379'),

  SESSION_SECRET: z.string().min(32),
  OTP_PEPPER: z.string().min(32),
  COOKIE_SECURE: bool,

  BUNDLE_MODE: z.enum(['one_time', 'subscription']).default('one_time'),
  CANCELLED_CARDS_COUNT_AGAINST_BUNDLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  CANCELLED_CARD_BALANCE_DESTINATION: z.enum(['wallet', 'source']).default('wallet'),
  VAT_RATE_BPS: z.coerce.number().int().default(500),
  COMPANY_TRN: z.string().default('TRN-PLACEHOLDER'),

  NYMCARD_MODE: z.enum(['mock', 'sandbox', 'production']).default('mock'),
  NYMCARD_BASE_URL: z.string().optional(),
  NYMCARD_API_KEY: z.string().optional(),
  NYMCARD_API_SECRET: z.string().optional(),
  NYMCARD_PRODUCT_ID: z.string().optional(),
  NYMCARD_WEBHOOK_SECRET: z.string().min(8),
  NYMCARD_WEBHOOK_SIGNATURE_HEADER: z.string().default('x-nymcard-signature'),

  PAYMENT_GATEWAY: z.enum(['mock', 'checkoutcom']).default('mock'),
  CHECKOUTCOM_SECRET_KEY: z.string().optional(),
  CHECKOUTCOM_PROCESSING_CHANNEL_ID: z.string().optional(),
  CHECKOUTCOM_WEBHOOK_SECRET: z.string().optional(),
  CHECKOUTCOM_BASE_URL: z.string().default('https://api.sandbox.checkout.com'),

  KYC_PROVIDER: z.enum(['mock']).default('mock'),
  KYC_MOCK_AUTO_APPROVE: bool,

  SMS_PROVIDER: z.enum(['console']).default('console'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().default(1025),
  SMTP_FROM: z.string().default('OnlinePay <no-reply@onlinepay.local>'),

  MONITOR_HIGH_AMOUNT_FILS: z.coerce.number().int().default(500000),
  MONITOR_VELOCITY_COUNT: z.coerce.number().int().default(5),
  MONITOR_DECLINE_COUNT: z.coerce.number().int().default(3),
  MONITOR_RISKY_MCCS: z
    .string()
    .default('7995,6051,4829')
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    // Print only variable names, never values.
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    if (
      env.NYMCARD_MODE === 'mock' ||
      env.PAYMENT_GATEWAY === 'mock' ||
      env.KYC_PROVIDER === 'mock'
    ) {
      throw new Error('Mock providers are not allowed in production');
    }
    if (!env.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be true in production');
  }
  return env;
}

export const env: Env = load();
export const isMockMode = () => env.NODE_ENV !== 'production';
