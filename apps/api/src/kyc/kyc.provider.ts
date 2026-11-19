import { randomUUID } from 'node:crypto';
import type { KycSubmitInput } from '@onlinepay/shared';

export const KYC_PROVIDER = Symbol('KYC_PROVIDER');

export interface KycSubmission {
  providerRef: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
}

/**
 * Identity verification provider. Document images are captured by the provider's own
 * web/mobile SDK and stay with the provider; we only keep their reference and the outcome.
 * Candidates: NymCard's KYC service (if offered for your programme), UAE PASS, or a vendor
 * such as Sumsub/Onfido — confirm with NymCard which one satisfies their onboarding rules.
 */
export interface KycProvider {
  readonly name: string;
  submit(userId: string, input: KycSubmitInput): Promise<KycSubmission>;
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
