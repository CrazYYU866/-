import { type CanActivate, type ExecutionContext, HttpStatus, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createParamDecorator } from '@nestjs/common';
import { ERROR_CODES, type AdminRole } from '@kovsh/contracts';
import { AppException } from '../common/app-exception';
import { AdminAuthService } from './admin-auth.service';

export interface AuthAdmin {
  adminId: string;
  sessionId: string;
  role: AdminRole;
  ip: string | null;
}

const ROLES_KEY = 'admin_roles';
/** Какие роли администраторов имеют доступ (В-40). Без декоратора — любой активный администратор. */
export const AdminRoles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentAdmin = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthAdmin => {
  const admin = ctx.switchToHttp().getRequest<{ admin?: AuthAdmin }>().admin;
  if (!admin) throw new Error('CurrentAdmin без AdminAuthGuard');
  return admin;
});

@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, string | undefined>; ip?: string; admin?: AuthAdmin }>();
    const header = req.headers['authorization'];
    const payload = header?.startsWith('Bearer ') ? await this.auth.verifyAccess(header.slice(7)) : null;
    if (!payload) throw new AppException(ERROR_CODES.UNAUTHORIZED, 'Требуется вход администратора', HttpStatus.UNAUTHORIZED);

    const roles = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles && roles.length > 0 && !roles.includes(payload.role)) {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Недостаточно прав', HttpStatus.FORBIDDEN);
    }
    req.admin = { adminId: payload.sub, sessionId: payload.sid, role: payload.role, ip: req.ip ?? null };
    return true;
  }
}
