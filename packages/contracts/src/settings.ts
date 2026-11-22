import { z } from 'zod';

/**
 * Реестр настраиваемых параметров платформы (ТЗ §22).
 * Значение по умолчанию задаётся только там, где оно утверждено заказчиком.
 * `null` по умолчанию = значение не утверждено; функциональность, которая от него зависит,
 * не должна работать, пока администратор не задаст значение.
 */
const percent = z.number().min(0).max(100);
const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().min(0);

export const SETTINGS_REGISTRY = {
  // Распределение заказов
  offer_timeout_sec: { schema: positiveInt, default: 40, source: 'ТЗ §8' },
  search_radius_start_km: { schema: positiveInt, default: 30, source: 'Н-17' },
  search_radius_step_km: { schema: positiveInt, default: 20, source: 'Н-17' },
  search_radius_step_interval_sec: { schema: positiveInt, default: 120, source: 'Н-17' },
  search_radius_max_km: { schema: positiveInt, default: 150, source: 'Н-17' },
  urgent_threshold_hours: { schema: positiveInt, default: 6, source: 'К-2' },
  search_timeout_urgent_min: { schema: positiveInt, default: 30, source: 'В 2.6, К-2' },
  search_timeout_scheduled_min: { schema: positiveInt, default: 360, source: 'В 2.7, К-2' },
  search_stop_before_start_min: { schema: nonNegativeInt, default: 30, source: 'К-2' },
  max_booking_horizon_days: { schema: positiveInt, default: 30, source: 'Н-16' },
  matching_weight_distance: { schema: percent, default: 40, source: 'К-6' },
  matching_weight_rating: { schema: percent, default: 20, source: 'К-6' },
  matching_weight_reliability: { schema: percent, default: 25, source: 'К-6' },
  matching_weight_load: { schema: percent, default: 15, source: 'К-6' },

  // Смены и время
  min_order_hours: { schema: positiveInt, default: 4, source: 'В 3.2, С-19' },
  min_multiday_day_hours: { schema: positiveInt, default: 8, source: 'М-1, С-19' },
  max_shift_hours: { schema: positiveInt, default: 11, source: 'В 3.3' },
  order_hour_step: { schema: positiveInt, default: 1, source: 'В 3.4' },

  // Оплата
  prepayment_percent: { schema: percent, default: 50, source: 'В 4.1' },
  prepayment_timeout_min: { schema: positiveInt, default: 10, source: 'Н-8' },
  assignment_deadline_min: { schema: positiveInt, default: 10, source: 'Р-7, Н-8' },
  assignment_reminder_minutes: { schema: z.array(positiveInt), default: [5, 8], source: 'П-6' },
  completion_auto_confirm_hours: { schema: positiveInt, default: 24, source: 'Н-19' },
  final_payment_timeout_hours: { schema: positiveInt, default: 24, source: 'Н-9, К-9' },
  invoice_min_lead_business_days: { schema: positiveInt, default: 3, source: 'К-1' },
  invoice_funds_deadline_before_start_hours: { schema: positiveInt, default: 24, source: 'К-1' },
  /** Общая комиссия от полной суммы заказа (аренда + расчётная доставка) — Ф-1. */
  platform_commission_percent: { schema: percent, default: 12, source: 'Ф-1' },
  /** Вознаграждение независимого диспетчера — процент от полной суммы заказа, внутри общей комиссии (Ф-1). */
  agent_commission_percent: { schema: percent, default: 7, source: 'Ф-1' },
  first_order_promo_percent: { schema: percent, default: 10, source: 'В-33' },
  support_refund_limit_kopecks: { schema: nonNegativeInt, default: 1_000_000, source: 'К-14' },

  // Вход по SMS и сессии. Технические значения безопасности, не бизнес-правила:
  // предложены разработкой, могут быть изменены администратором.
  otp_code_length: { schema: z.number().int().min(4).max(8), default: 6, source: 'техническое' },
  otp_ttl_sec: { schema: positiveInt, default: 300, source: 'техническое' },
  otp_max_attempts: { schema: positiveInt, default: 5, source: 'техническое' },
  otp_resend_cooldown_sec: { schema: positiveInt, default: 60, source: 'техническое' },
  otp_max_per_phone_per_hour: { schema: positiveInt, default: 5, source: 'техническое' },
  otp_max_per_ip_per_hour: { schema: positiveInt, default: 30, source: 'техническое' },
  access_token_ttl_sec: { schema: positiveInt, default: 900, source: 'техническое' },
  refresh_token_ttl_days: { schema: positiveInt, default: 30, source: 'техническое' },

  quote_ttl_min: { schema: positiveInt, default: 15, source: 'С-20' },
  min_lead_time_min: { schema: positiveInt, default: 60, source: 'Л-4' },

  // Реквизиты платформы для счетов (Н-23, К-1). Не утверждены — выставление счетов выключено, пока не заданы.
  platform_legal_name: { schema: z.string().min(2), default: null, source: 'не задано' },
  platform_inn: { schema: z.string().regex(/^(\d{10}|\d{12})$/), default: null, source: 'не задано' },
  platform_kpp: { schema: z.string().regex(/^\d{9}$/), default: null, source: 'не задано' },
  platform_legal_address: { schema: z.string().min(5), default: null, source: 'не задано' },
  platform_bank_name: { schema: z.string().min(2), default: null, source: 'не задано' },
  platform_bik: { schema: z.string().regex(/^\d{9}$/), default: null, source: 'не задано' },
  platform_account: { schema: z.string().regex(/^\d{20}$/), default: null, source: 'не задано' },
  platform_corr_account: { schema: z.string().regex(/^\d{20}$/), default: null, source: 'не задано' },

  /** Через сколько секунд без новых координат показывать «нет связи с техникой» и не показывать ETA (Р-19–21). */
  tracking_stale_sec: { schema: positiveInt, default: 180, source: 'техническое' },
  /** Сколько минут действует выданный подменный номер. */
  call_number_ttl_min: { schema: positiveInt, default: 30, source: 'техническое' },

  // Хранение данных
  gps_retention_hours: { schema: positiveInt, default: 48, source: 'П-16' },
  call_recording_retention_days: { schema: positiveInt, default: 180, source: 'В-27' },
  chat_retention_days: { schema: positiveInt, default: 180, source: 'В-27' },
} as const satisfies Record<string, { schema: z.ZodTypeAny; default: unknown; source: string }>;

export type SettingKey = keyof typeof SETTINGS_REGISTRY;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS_REGISTRY)[K]['schema']>;

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY, key);
}
