import { z } from 'zod';
import { CLIENT_APPS } from './roles';

export const OtpRequestSchema = z.object({
  phone: z.string().min(5).max(32),
  app: z.enum(CLIENT_APPS),
});
export type OtpRequest = z.infer<typeof OtpRequestSchema>;

export const OtpVerifySchema = z.object({
  phone: z.string().min(5).max(32),
  app: z.enum(CLIENT_APPS),
  code: z.string().regex(/^\d{4,8}$/),
  deviceId: z.string().max(200).optional(),
});
export type OtpVerify = z.infer<typeof OtpVerifySchema>;

export const RefreshRequestSchema = z.object({ refreshToken: z.string().min(20).max(200) });
export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

export const UpdateMeSchema = z.object({ fullName: z.string().trim().min(2).max(120) });
export type UpdateMe = z.infer<typeof UpdateMeSchema>;

export const PUSH_PLATFORMS = ['ios', 'android'] as const;
export const RegisterPushDeviceSchema = z.object({
  platform: z.enum(PUSH_PLATFORMS),
  token: z.string().min(10).max(500),
});
export type RegisterPushDevice = z.infer<typeof RegisterPushDeviceSchema>;

export interface MeResponse {
  id: string;
  phone: string;
  fullName: string | null;
  status: 'active' | 'blocked';
  createdAt: string;
}

export interface AuthTokensResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  user: MeResponse;
  isNewUser: boolean;
}

export interface OtpRequestResponse {
  /** Через сколько секунд можно запросить код повторно. */
  resendAfterSec: number;
  expiresInSec: number;
}
