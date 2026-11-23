import { z } from 'zod';

/** Булево из переменной окружения: только «true»/«false» (z.coerce.boolean считает «false» истиной). */
const envBool = (def: boolean) => z.enum(['true', 'false']).default(def ? 'true' : 'false').transform((v) => v === 'true');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  REDIS_URL: z.string().url(),
  /** Секрет подписи access-токенов. Не короче 32 символов. */
  JWT_ACCESS_SECRET: z.string().min(32),
  /** Секрет для хэширования SMS-кодов. Не короче 32 символов. */
  OTP_HASH_SECRET: z.string().min(32),
  /**
   * Провайдер SMS. `dev` пишет код в лог и доступен только вне production.
   * Реальные провайдеры (SMS.ru / МТС Exolve, В-35) подключаются после выбора.
   */
  SMS_PROVIDER: z.enum(['dev']).default('dev'),
  /** Ключ шифрования чувствительных полей (AES-256-GCM): 32 байта в base64. */
  DATA_ENCRYPTION_KEY: z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'нужно 32 байта в base64'),
  /** Секрет подписи access-токенов администраторов. */
  ADMIN_JWT_SECRET: z.string().min(32),
  /** Хранилище файлов: local (диск, для разработки) или s3 (Yandex Object Storage, В-37). */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./var/storage'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('ru-central1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** Маршрутизация: dev — приблизительный расчёт для разработки; yandex — после получения ключа (П-19). */
  ROUTING_PROVIDER: z.enum(['dev']).default('dev'),
  /** Подсказки адресов. `dev` — встроенный тестовый список; Яндекс Геосаджест — после получения ключа. */
  GEOCODER_PROVIDER: z.enum(['dev']).default('dev'),
  /** Запускать обработчик отложенных заданий в этом процессе. */
  JOBS_AUTORUN: envBool(true),
  /** Платёжный провайдер: dev — тестовые оплаты без денег; yookassa — после договора (В-34). */
  PAYMENT_PROVIDER: z.enum(['dev']).default('dev'),
  /** Push: dev — запись в лог; expo — после подключения (ТЗ §16). */
  PUSH_PROVIDER: z.enum(['dev']).default('dev'),
  /** Подменные номера: dev — условный номер без звонка; провайдер выбирается (В-35). */
  TELEPHONY_PROVIDER: z.enum(['dev']).default('dev'),
  /** Внешний адрес API (ссылки оплаты, SMS-ссылки). */
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  /** Доверять заголовку X-Forwarded-For (за балансировщиком). */
  TRUST_PROXY: envBool(false),
  /** Лимит запросов с одного IP в минуту; 0 — без ограничения (технический параметр, ТЗ §19). */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(0).default(600),
  /** Лимит запросов входа (SMS-коды, токены, вход администратора) с одного IP в минуту. */
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(0).default(30),
  /** Документация API (Swagger). В production по умолчанию выключена. */
  SWAGGER_ENABLED: envBool(true),
  /** Как часто снимок настроек платформы перечитывается из БД (мс); 0 — читать при каждом обращении (только тесты). */
  SETTINGS_CACHE_MS: z.coerce.number().int().min(0).default(5000),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.SMS_PROVIDER === 'dev') {
    ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message: 'тестовый SMS-провайдер запрещён в production' });
  }
  if (env.NODE_ENV === 'production' && env.GEOCODER_PROVIDER === 'dev') {
    ctx.addIssue({ code: 'custom', path: ['GEOCODER_PROVIDER'], message: 'тестовый геокодер запрещён в production' });
  }
  if (env.NODE_ENV === 'production' && env.ROUTING_PROVIDER === 'dev') {
    ctx.addIssue({ code: 'custom', path: ['ROUTING_PROVIDER'], message: 'тестовая маршрутизация запрещена в production' });
  }
  if (env.NODE_ENV === 'production' && (env.PUSH_PROVIDER === 'dev' || env.TELEPHONY_PROVIDER === 'dev')) {
    ctx.addIssue({ code: 'custom', path: ['TELEPHONY_PROVIDER'], message: 'тестовые push и телефония запрещены в production' });
  }
  if (env.NODE_ENV === 'production' && env.PAYMENT_PROVIDER === 'dev') {
    ctx.addIssue({ code: 'custom', path: ['PAYMENT_PROVIDER'], message: 'тестовые платежи запрещены в production' });
  }
  if (env.STORAGE_DRIVER === 's3' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)) {
    ctx.addIssue({ code: 'custom', path: ['S3_BUCKET'], message: 'для s3 нужны S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY' });
  }
  if (env.NODE_ENV === 'production' && env.STORAGE_DRIVER === 'local') {
    ctx.addIssue({ code: 'custom', path: ['STORAGE_DRIVER'], message: 'локальное хранилище запрещено в production' });
  }
});

export type AppEnv = z.infer<typeof EnvSchema>;

/** Читает и проверяет переменные окружения. При ошибке приложение не стартует. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Некорректная конфигурация окружения: ${issues}`);
  }
  return parsed.data;
}
