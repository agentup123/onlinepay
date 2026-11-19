import { randomUUID } from 'node:crypto';
import type { KycSubmitInput } from '@onlinepay/shared';

export const KYC_PROVIDER = Symbol('KYC_PROVIDER');
export const SCREENING_PROVIDER = Symbol('SCREENING_PROVIDER');

export type KycDecision = 'PENDING' | 'APPROVED' | 'REJECTED';

/** Identity data the provider extracted from the document. Always preferred over user input. */
export interface VerifiedIdentity {
  dateOfBirth?: string; // YYYY-MM-DD
  nationality?: string; // ISO-3166 alpha-2
}

export interface KycSubmission {
  providerRef: string;
  status: KycDecision;
  verified?: VerifiedIdentity;
}

export interface KycApplicant {
  userId: string;
  fullName: string;
  email: string;
  phone: string;
}

/** A decision the provider pushed to us asynchronously (most real vendors work this way). */
export interface KycWebhookDecision {
  providerRef: string;
  status: KycDecision;
  verified?: VerifiedIdentity;
  reviewNote?: string;
}

/**
 * Identity-verification provider (Emirates ID / passport + liveness). Document images are
 * captured by the provider's own web/mobile SDK and stay with the provider; we only keep their
 * reference, the outcome and the verified date of birth / nationality.
 *
 * To add the vendor NymCard approves, see docs/KYC_INTEGRATION.md.
 */
export interface KycProvider {
  readonly name: string;
  submit(applicant: KycApplicant, input: KycSubmitInput): Promise<KycSubmission>;
  /** Verifies the provider's webhook signature over the raw body. */
  verifyWebhook?(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  /** Maps a verified webhook body to a decision, or null for events we don't act on. */
  parseWebhook?(body: Record<string, unknown>): KycWebhookDecision | null;
}

export type ScreeningStatus = 'CLEAR' | 'POTENTIAL_MATCH' | 'ERROR';

export interface ScreeningSubject {
  userId: string;
  fullName: string;
  dateOfBirth: string; // YYYY-MM-DD
  nationality: string;
}

export interface ScreeningResult {
  status: ScreeningStatus;
  /** Vendor case/check id, for the compliance team to open the case. */
  ref: string;
  /** Short, non-sensitive summary such as "2 potential matches (sanctions, PEP)". */
  summary?: string;
}

/**
 * Sanctions / PEP / adverse-media screening (UAE Local Terrorist List, UN, OFAC, EU, UK and PEP
 * lists as required by your AML programme). Runs before any approval and again periodically.
 * Often the same vendor as KYC; kept separate so either can change independently.
 */
export interface ScreeningProvider {
  readonly name: string;
  screen(subject: ScreeningSubject): Promise<ScreeningResult>;
}

export class MockKycProvider implements KycProvider {
  readonly name = 'mock';
  constructor(private readonly autoApprove: boolean) {}

  async submit(): Promise<KycSubmission> {
    return {
      providerRef: `mock-kyc-${randomUUID()}`,
      status: this.autoApprove ? 'APPROVED' : 'PENDING',
    };
  }
}

/**
 * Dev/test screening: everyone is clear except names containing "SANCTIONED" (potential match)
 * or "SCREENFAIL" (provider error), so both paths can be exercised end to end.
 */
export class MockScreeningProvider implements ScreeningProvider {
  readonly name = 'mock';

  async screen(subject: ScreeningSubject): Promise<ScreeningResult> {
    const name = subject.fullName.toUpperCase();
    if (name.includes('SCREENFAIL')) return { status: 'ERROR', ref: `mock-scr-${randomUUID()}` };
    if (name.includes('SANCTIONED')) {
      return {
        status: 'POTENTIAL_MATCH',
        ref: `mock-scr-${randomUUID()}`,
        summary: '1 potential match (sanctions)',
      };
    }
    return { status: 'CLEAR', ref: `mock-scr-${randomUUID()}` };
  }
}
