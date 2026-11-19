import { z } from 'zod';

/** UAE mobile numbers in E.164: +9715XXXXXXXX */
export const uaePhoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, ''))
  .transform((v) => (v.startsWith('05') ? `+971${v.slice(1)}` : v))
  .refine((v) => /^\+9715\d{8}$/.test(v), 'Enter a valid UAE mobile number');

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const otpCodeSchema = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

export const localeSchema = z.enum(['en', 'ar']);

export const signupStartSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  email: emailSchema,
  phone: uaePhoneSchema,
  locale: localeSchema.default('en'),
  acceptTerms: z.literal(true),
});

export const loginStartSchema = z.object({ email: emailSchema });

export const otpVerifySchema = z.object({
  challengeId: z.string().uuid(),
  code: otpCodeSchema,
});

export const kycSubmitSchema = z.object({
  documentType: z.enum(['EMIRATES_ID', 'PASSPORT']),
  nationality: z.string().length(2).toUpperCase(),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * Reference returned by the KYC provider's own capture SDK. We never upload or store
   * ID images or full document numbers on our servers.
   */
  providerCaptureRef: z.string().min(1).max(200),
});

export const cardLabelSchema = z.string().trim().min(1).max(40);

export const createCardSchema = z.object({
  label: cardLabelSchema,
  spendingLimitFils: z.number().int().positive().max(5_000_000).optional(),
});

export const renameCardSchema = z.object({ label: cardLabelSchema });

export const fundCardSchema = z.object({
  amountFils: z.number().int().min(100).max(5_000_000),
});

export const setLimitSchema = z.object({
  spendingLimitFils: z.number().int().positive().max(5_000_000).nullable(),
});

export const walletTopUpSchema = z.object({
  amountFils: z.number().int().min(1000).max(5_000_000),
});

export type SignupStartInput = z.infer<typeof signupStartSchema>;
export type KycSubmitInput = z.infer<typeof kycSubmitSchema>;
export type CreateCardInput = z.infer<typeof createCardSchema>;
