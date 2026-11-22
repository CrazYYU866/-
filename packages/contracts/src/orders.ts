import { z } from 'zod';
import { GeoPointSchema } from './catalog';
import { PayerSchema } from './finance';

export const CreateOrderSchema = z.object({
  quoteId: z.string().uuid(),
  siteComment: z.string().trim().max(1000).optional(),
  /** Кто платит: физлицо (100% после принятия) или юрлицо заказчика (50/50) — решения 07. */
  payer: PayerSchema.default({ kind: 'individual' }),
});
export type CreateOrder = z.infer<typeof CreateOrderSchema>;

export const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(2000) });
export const OptionalReasonSchema = z.object({ reason: z.string().trim().max(2000).optional() });

export const AssignOperatorSchema = z.object({
  memberId: z.string().uuid(),
  /** Смена; не указана — первая смена без машиниста. */
  shiftId: z.string().uuid().optional(),
});
export type AssignOperator = z.infer<typeof AssignOperatorSchema>;

export const ReplaceUnitSchema = z.object({ unitId: z.string().uuid() });

export const OPERATOR_STATUSES = ['en_route', 'arrived', 'in_progress', 'finished'] as const;
export type OperatorStatus = (typeof OPERATOR_STATUSES)[number];
export const LOCATION_UNAVAILABLE_REASONS = ['permission_denied', 'gps_off', 'timeout', 'unknown'] as const;

/** Офлайн-события машиниста (Р-18, П-15): копятся на телефоне и отправляются пачкой. */
export const StatusEventsSchema = z.object({
  events: z
    .array(
      z.object({
        clientEventId: z.string().uuid(),
        status: z.enum(OPERATOR_STATUSES),
        recordedAt: z.string().datetime({ offset: true }),
        point: GeoPointSchema.optional(),
        locationUnavailableReason: z.enum(LOCATION_UNAVAILABLE_REASONS).optional(),
      }),
    )
    .min(1)
    .max(50),
});
export type StatusEvents = z.infer<typeof StatusEventsSchema>;

export const ReportIncidentSchema = z.object({
  type: z.enum(['breakdown', 'other']),
  comment: z.string().trim().max(2000).optional(),
  fileIds: z.array(z.string().uuid()).max(10).default([]),
});
export type ReportIncident = z.infer<typeof ReportIncidentSchema>;
