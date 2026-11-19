'use client';

import { notFound } from 'next/navigation';

/**
 * DEV ONLY: stands in for NymCard's hosted secure card display. Shows an obviously FAKE card
 * number. In sandbox/production the iframe loads the issuer's own page instead.
 */
export default function MockSecureDisplay() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <div className="space-y-2 p-4 font-mono text-sm" dir="ltr">
      <p className="text-xs font-bold text-amber-700">MOCK — not a real card</p>
      <p className="text-lg tracking-widest">4000 0000 0000 0002</p>
      <p>EXP 12/29 · CVV 123</p>
    </div>
  );
}
