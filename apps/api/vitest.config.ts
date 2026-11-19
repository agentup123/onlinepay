import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is used so Nest decorators + metadata compile the same way as in the real build.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      SESSION_SECRET: 'test-session-secret-test-session-secret',
      OTP_PEPPER: 'test-otp-pepper-test-otp-pepper-test-otp',
      NYMCARD_WEBHOOK_SECRET: 'test-webhook-secret',
    },
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
