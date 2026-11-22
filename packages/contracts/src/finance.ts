import { z } from 'zod';

export const PAYER_KINDS = ['individual', 'legal'] as const;
export type PayerKind = (typeof PAYER_KINDS)[number];

export const PayerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('individual') }),
  z.object({ kind: z.literal('legal'), legalProfileId: z.string().uuid() }),
]);
export type Payer = z.infer<typeof PayerSchema>;

export const LegalProfileSchema = z.object({
  inn: z.string().regex(/^(\d{10}|\d{12})$/),
  kpp: z.string().regex(/^\d{9}$/).optional(),
  name: z.string().trim().min(2).max(300),
  legalAddress: z.string().trim().min(5).max(500),
  email: z.string().trim().email().max(200),
});
export type LegalProfileInput = z.infer<typeof LegalProfileSchema>;

/** Решение поддержки по отмене после оплаты (решения 07): сколько удержать, остальное вернуть. */
export const CancellationDecisionSchema = z.object({
  retainedKopecks: z.number().int().min(0),
  reason: z.string().trim().min(3).max(2000),
});
export type CancellationDecision = z.infer<typeof CancellationDecisionSchema>;

export interface PaymentView {
  id: string;
  part: 'first' | 'final';
  amountKopecks: number;
  status: 'pending' | 'succeeded' | 'cancelled' | 'failed';
  confirmationUrl: string | null;
  createdAt: string;
  paidAt: string | null;
}
