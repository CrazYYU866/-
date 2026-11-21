import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ERROR_CODES, type OrgMemberRole, type OrganizationStatus } from '@kovsh/contracts';
import { and, eq } from 'drizzle-orm';
import type { AuthedRequest } from '../auth/current-user';
import { AppException } from '../common/app-exception';
import { DB, type Database } from '../database/database.module';
import { organizationMembers, organizations } from '../database/schema';

export interface OrgContext {
  orgId: string;
  memberId: string;
  role: OrgMemberRole;
  canOperate: boolean;
  orgStatus: OrganizationStatus;
  orgKind: 'partner' | 'agent';
}

const ROLES_KEY = 'org_roles';
const ALLOW_BLOCKED_KEY = 'org_allow_blocked';

/** Какие роли в организации допускаются к операции (Р-1, Р-2, Р-10, Р-11). */
export const OrgRoles = (...roles: OrgMemberRole[]) => SetMetadata(ROLES_KEY, roles);
/** Операция доступна и заблокированной организации (например, просмотр статуса). */
export const AllowBlockedOrg = () => SetMetadata(ALLOW_BLOCKED_KEY, true);

export const CurrentOrg = createParamDecorator((_d: unknown, ctx: ExecutionContext): OrgContext => {
  const org = ctx.switchToHttp().getRequest<{ org?: OrgContext }>().org;
  if (!org) throw new Error('CurrentOrg без OrgContextGuard');
  return org;
});

/**
 * Контекст организации для партнёрского API (Р-13): заголовок X-Org-Id.
 * Сервер проверяет активное членство и роль именно в этой организации,
 * поэтому данные разных компаний не смешиваются даже у одного пользователя.
 */
@Injectable()
export class OrgContextGuard implements CanActivate {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<AuthedRequest & { headers: Record<string, string | undefined>; org?: OrgContext }>();
    if (!req.user) throw new Error('OrgContextGuard требует JwtAuthGuard');
    if (req.user.app !== 'partner') {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Доступно только в приложении партнёра', HttpStatus.FORBIDDEN);
    }
    const orgId = req.headers['x-org-id'];
    if (!orgId || !/^[0-9a-f-]{36}$/i.test(orgId)) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Укажите организацию в заголовке X-Org-Id', HttpStatus.BAD_REQUEST);
    }
    const [row] = await this.db
      .select({
        memberId: organizationMembers.id,
        role: organizationMembers.role,
        canOperate: organizationMembers.canOperate,
        orgStatus: organizations.status,
        orgKind: organizations.kind,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(
        and(
          eq(organizationMembers.orgId, orgId),
          eq(organizationMembers.userId, req.user.userId),
          eq(organizationMembers.status, 'active'),
        ),
      );
    // Не раскрываем, существует ли чужая организация.
    if (!row) throw new AppException(ERROR_CODES.NOT_A_MEMBER, 'Организация не найдена', HttpStatus.NOT_FOUND);

    const allowBlocked = this.reflector.getAllAndOverride<boolean>(ALLOW_BLOCKED_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (row.orgStatus === 'blocked' && !allowBlocked) {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Организация заблокирована', HttpStatus.FORBIDDEN);
    }
    const roles = this.reflector.getAllAndOverride<OrgMemberRole[] | undefined>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (roles && !roles.includes(row.role)) {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Недостаточно прав в организации', HttpStatus.FORBIDDEN);
    }
    req.org = { orgId, ...row };
    return true;
  }
}
