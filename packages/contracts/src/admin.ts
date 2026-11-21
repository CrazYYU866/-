import { z } from 'zod';
import { ADMIN_ROLES } from './roles';

export const AdminLoginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(200),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
});
export type AdminLogin = z.infer<typeof AdminLoginSchema>;

export const CreateAdminSchema = z.object({
  email: z.string().trim().email(),
  fullName: z.string().trim().min(2).max(200),
  role: z.enum(ADMIN_ROLES),
  password: z.string().min(12).max(200),
});
export type CreateAdmin = z.infer<typeof CreateAdminSchema>;

export const UpdateAdminSchema = z.object({
  role: z.enum(ADMIN_ROLES).optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type UpdateAdmin = z.infer<typeof UpdateAdminSchema>;

export const TotpConfirmSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const BlockUserSchema = z.object({ reason: z.string().trim().min(3).max(2000) });

export const UpdateSettingSchema = z.object({ value: z.unknown(), reason: z.string().trim().max(2000).optional() });
