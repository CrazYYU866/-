import { z } from 'zod';
import { GeoPointSchema } from './catalog';

/** Требование к характеристике: точное значение (список, да/нет) или минимум для числа. */
export const RequirementValueSchema = z.union([
  z.string().max(100),
  z.boolean(),
  z.object({ min: z.number() }),
]);
export type RequirementValue = z.infer<typeof RequirementValueSchema>;

/** День многодневного заказа: заказчик сам выбирает дни и часы (Л-1). Время — местное время региона объекта. */
export const OrderDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  hours: z.number().int().positive().max(24),
});
export type OrderDay = z.infer<typeof OrderDaySchema>;

export const QuoteRequestSchema = z.object({
  categoryId: z.string().uuid(),
  site: GeoPointSchema.extend({ address: z.string().trim().min(3).max(500) }),
  requirements: z.record(z.string(), RequirementValueSchema).default({}),
  days: z.array(OrderDaySchema).min(1).max(31),
  promoCode: z.string().trim().min(2).max(64).optional(),
});
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export interface QuoteShift {
  start: string;
  end: string;
  hours: number;
}

export interface QuoteResponse {
  id: string;
  expiresAt: string;
  urgency: 'urgent' | 'scheduled';
  region: { id: string; name: string };
  totalHours: number;
  shifts: QuoteShift[];
  hourPriceKopecks: number;
  kmPriceKopecks: number;
  deliveryKm: number;
  rentKopecks: number;
  deliveryKopecks: number;
  /** Полная стоимость (база комиссии). */
  totalKopecks: number;
  /** Скидка по промокоду — за счёт комиссии платформы (Н-15). */
  discountKopecks: number;
  /** К оплате заказчиком: полная стоимость − скидка. */
  payableKopecks: number;
  /** Первый платёж физлица после принятия исполнителем — 100% (решения 07). */
  prepaymentKopecks: number;
  /** Первый платёж юрлица после принятия — 50%; остальное после завершения (решения 07). */
  legalFirstPaymentKopecks: number;
}

/** Расчёт для заявки независимого диспетчера: тот же расчёт + телефон фактического заказчика (Н-27). */
export const AgentQuoteRequestSchema = QuoteRequestSchema.extend({ customerPhone: z.string().min(5).max(32) });
export type AgentQuoteRequest = z.infer<typeof AgentQuoteRequestSchema>;
