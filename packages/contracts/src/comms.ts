import { z } from 'zod';
import { GeoPointSchema } from './catalog';

export const CHAT_CHANNELS = ['order', 'internal'] as const;
export type ChatChannel = (typeof CHAT_CHANNELS)[number];
export const SendMessageSchema = z.object({ body: z.string().trim().min(1).max(4000) });
export const ReadMessagesSchema = z.object({ lastReadId: z.number().int().positive() });

export const LocationBatchSchema = z.object({
  orderId: z.string().uuid(),
  points: z
    .array(
      GeoPointSchema.extend({
        accuracy: z.number().min(0).max(10_000).optional(),
        speed: z.number().min(0).max(100).optional(),
        heading: z.number().min(0).max(360).optional(),
        battery: z.number().min(0).max(1).optional(),
        recordedAt: z.string().datetime({ offset: true }),
      }),
    )
    .min(1)
    .max(500),
});
export type LocationBatch = z.infer<typeof LocationBatchSchema>;

export const RateSchema = z.object({
  stars: z.number().int().min(1).max(5),
  text: z.string().trim().max(2000).optional(),
  /** Кого оценивает заказчик: машинист заказа (по умолчанию — единственный). */
  targetUserId: z.string().uuid().optional(),
});
export type RateInput = z.infer<typeof RateSchema>;

export const BroadcastSchema = z.object({
  audience: z.enum(['all_customers', 'all_partners', 'user']),
  userId: z.string().uuid().optional(),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(1000),
});
export type Broadcast = z.infer<typeof BroadcastSchema>;
export const MarkNotificationsReadSchema = z.object({ ids: z.array(z.number().int().positive()).max(500).optional(), all: z.boolean().optional() });
