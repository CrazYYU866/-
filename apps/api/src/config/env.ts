import { z } from 'zod';

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
  /** Доверять заголовку X-Forwarded-For (за балансировщиком). */
  TRUST_PROXY: z.coerce.boolean().default(false),
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.SMS_PROVIDER === 'dev') {
    ctx.addIssue({ code: 'custom', path: ['SMS_PROVIDER'], message: 'тестовый SMS-провайдер запрещён в production' });
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
