import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');
const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const isDev = process.env.NODE_ENV !== 'production';

// NymCard's secure card-display iframe origin must be allowed in frame-src.
// TODO(nymcard-docs): set NYMCARD_SECURE_DISPLAY_ORIGIN to NymCard's hosted display origin.
const secureDisplayOrigin = process.env.NYMCARD_SECURE_DISPLAY_ORIGIN ?? '';

const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  `frame-src 'self' ${secureDisplayOrigin}`.trim(),
  "frame-ancestors 'self'",
  "form-action 'self'",
  "base-uri 'self'",
].join('; ');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@onlinepay/shared'],
  // The browser only ever talks to this origin; /api is proxied to the NestJS API so
  // session cookies stay first-party and API credentials never reach the client.
  async rewrites() {
    // Never proxy the admin API through the public consumer site.
    return [{ source: '/api/:path((?!admin(?:/|$)).*)', destination: `${API_URL}/:path` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
