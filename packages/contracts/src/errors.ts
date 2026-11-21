import { z } from 'zod';

/** Единый формат ошибки API. */
export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
  requestId: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
  SETTING_NOT_CONFIGURED: 'SETTING_NOT_CONFIGURED',
  INVALID_PHONE: 'INVALID_PHONE',
  OTP_COOLDOWN: 'OTP_COOLDOWN',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_ATTEMPTS_EXCEEDED: 'OTP_ATTEMPTS_EXCEEDED',
  USER_BLOCKED: 'USER_BLOCKED',
  REFRESH_INVALID: 'REFRESH_INVALID',
  REFRESH_REUSED: 'REFRESH_REUSED',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
