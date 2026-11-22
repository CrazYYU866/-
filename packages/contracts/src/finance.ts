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
  part: 'first' | 'final' | 'extra';
  amountKopecks: number;
  status: 'pending' | 'succeeded' | 'cancelled' | 'failed';
  confirmationUrl: string | null;
  createdAt: string;
  paidAt: string | null;
}

/** Организация заказчика (Н-30): создаёт руководитель, сотрудников он приглашает по телефону. */
export const CustomerOrgSchema = LegalProfileSchema;
export const InviteCustomerEmployeeSchema = z.object({ phone: z.string().min(5).max(32) });
export const RequestExtensionSchema = z.object({ hours: z.number().int().positive().max(24) });

/** Заявка независимого диспетчера за фактического заказчика (Н-27). */
export const AgentOrderSchema = z.object({
  quoteId: z.string().uuid(),
  siteComment: z.string().trim().max(1000).optional(),
});
export const ConfirmByLinkSchema = z.object({ payer: PayerSchema });

export const PromoCodeSchema = z.object({
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{3,32}$/),
  percent: z.number().int().min(1).max(100).default(10),
  firstOrderOnly: z.boolean().default(true),
  validFrom: z.string().datetime({ offset: true }).nullable().optional(),
  validTo: z.string().datetime({ offset: true }).nullable().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  personalPhone: z.string().min(5).max(32).nullable().optional(),
  description: z.string().trim().max(500).optional(),
});
export type PromoCodeInput = z.infer<typeof PromoCodeSchema>;
export const UpdatePromoCodeSchema = z.object({
  active: z.boolean().optional(),
  validTo: z.string().datetime({ offset: true }).nullable().optional(),
  maxUses: z.number().int().positive().nullable().optional(),
  description: z.string().trim().max(500).optional(),
});
export const InvoiceRequestSchema = z.object({ part: z.enum(['first', 'final']) });
export const CalendarDaySchema = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), isWorking: z.boolean(), note: z.string().max(200).optional() });
