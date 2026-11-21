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
  totalKopecks: number;
  /** Оплата после принятия исполнителем: первая часть (В 4.1). */
  prepaymentKopecks: number;
}
