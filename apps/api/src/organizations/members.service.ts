import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, type InviteMember, type OrgMemberRole } from '@kovsh/contracts';
import { and, eq, ne, sql } from 'drizzle-orm';
import { normalizePhone } from '../auth/phone';
import { SMS_PROVIDER, type SmsProvider } from '../auth/sms/sms.provider';
import { AppException } from '../common/app-exception';
import { DB, type Database } from '../database/database.module';
import { organizationMembers, organizations, userActionLog, users } from '../database/schema';
import { UsersService } from '../users/users.service';
import type { OrgContext } from './org-context.guard';

export type MemberRow = typeof organizationMembers.$inferSelect;

export interface MemberView {
  id: string;
  userId: string;
  fullName: string | null;
  phone: string;
  role: OrgMemberRole;
  canOperate: boolean;
  status: string;
  operatorVerification: string;
  joinedAt: string | null;
}

export interface InvitationView {
  memberId: string;
  orgId: string;
  orgName: string;
  role: OrgMemberRole;
  invitedAt: string;
}

/** Проверка «у машиниста нет незавершённых заказов в этой компании» (Р-15, П-11). */
export interface ActiveOrdersCheck {
  hasUnfinishedOrders(orgId: string, userId: string): Promise<boolean>;
}
export const ACTIVE_ORDERS_CHECK = Symbol('ACTIVE_ORDERS_CHECK');

const isUniqueViolation = (e: unknown, constraint: string): boolean => {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  const c = err.cause ?? err;
  return c.code === '23505' && c.constraint === constraint;
};

@Injectable()
export class MembersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(SMS_PROVIDER) private readonly sms: SmsProvider,
    @Inject(ACTIVE_ORDERS_CHECK) private readonly activeOrders: ActiveOrdersCheck,
    private readonly users: UsersService,
  ) {}

  async list(orgId: string): Promise<MemberView[]> {
    const rows = await this.db
      .select({ m: organizationMembers, u: users })
      .from(organizationMembers)
      .innerJoin(users, eq(users.id, organizationMembers.userId))
      .where(and(eq(organizationMembers.orgId, orgId), ne(organizationMembers.status, 'detached')))
      .orderBy(organizationMembers.createdAt);
    return rows.map(({ m, u }) => toView(m, u));
  }

  /** Приглашение сотрудника (Р-2): только руководители; руководителя назначает только главный владелец (Р-11). */
  async invite(ctx: OrgContext, actorUserId: string, dto: InviteMember): Promise<MemberView> {
    if (dto.role === 'manager' && ctx.role !== 'owner') {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Руководителя назначает только главный владелец', HttpStatus.FORBIDDEN);
    }
    const phone = normalizePhone(dto.phone);
    const { user } = await this.users.findOrCreateByPhone(phone);
    if (dto.fullName && !user.fullName) await this.users.updateProfile(user.id, dto.fullName);
    const canOperate = dto.role === 'operator';
    if (canOperate) await this.assertNotOperatorElsewhere(user.id, ctx.orgId);

    const [existing] = await this.db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, ctx.orgId), eq(organizationMembers.userId, user.id)));
    if (existing && existing.status !== 'detached') {
      throw new AppException(ERROR_CODES.CONFLICT, 'Этот человек уже есть в компании', HttpStatus.CONFLICT);
    }
    const values = {
      role: dto.role,
      canOperate,
      status: 'invited' as const,
      invitedBy: actorUserId,
      joinedAt: null,
      detachedAt: null,
      detachedBy: null,
    };
    const [row] = existing
      ? await this.db.update(organizationMembers).set(values).where(eq(organizationMembers.id, existing.id)).returning()
      : await this.db.insert(organizationMembers).values({ orgId: ctx.orgId, userId: user.id, ...values }).returning();
    if (!row) throw new Error('Не удалось создать приглашение');
    await this.log(actorUserId, ctx.orgId, 'member.invited', row.id, { role: dto.role });

    const [org] = await this.db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, ctx.orgId));
    await this.sms.send(phone, `Вас пригласили в компанию «${org?.name ?? ''}» в приложении «Ковш на Час Партнёр». Войдите по этому номеру, чтобы принять приглашение.`);
    return toView(row, await this.users.getById(user.id));
  }

  async changeRole(ctx: OrgContext, actorUserId: string, memberId: string, role: Exclude<OrgMemberRole, 'owner'>): Promise<MemberView> {
    const member = await this.getInOrg(ctx.orgId, memberId);
    if (member.role === 'owner') throw new AppException(ERROR_CODES.FORBIDDEN, 'Роль главного владельца не меняется', HttpStatus.FORBIDDEN);
    if ((role === 'manager' || member.role === 'manager') && ctx.role !== 'owner') {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Права руководителя назначает и отзывает только главный владелец', HttpStatus.FORBIDDEN);
    }
    const canOperate = role === 'operator' ? true : member.canOperate;
    if (canOperate && !member.canOperate && member.status === 'active') await this.assertNotOperatorElsewhere(member.userId, ctx.orgId);
    const row = await this.updateMember(memberId, { role, canOperate }, 'organization_members_operator_one_company_uq');
    await this.log(actorUserId, ctx.orgId, 'member.role_changed', memberId, { from: member.role, to: role });
    return toView(row, await this.users.getById(row.userId));
  }

  /** Работает ли руководитель или диспетчер машинистом (например, ИП-одиночка — П-13). */
  async setCanOperate(ctx: OrgContext, actorUserId: string, memberId: string, canOperate: boolean): Promise<MemberView> {
    const member = await this.getInOrg(ctx.orgId, memberId);
    if (member.role === 'operator') {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Машинист всегда работает машинистом', HttpStatus.BAD_REQUEST);
    }
    if (member.role === 'owner' && ctx.role !== 'owner') {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Недостаточно прав', HttpStatus.FORBIDDEN);
    }
    if (canOperate && member.status === 'active') await this.assertNotOperatorElsewhere(member.userId, ctx.orgId);
    const row = await this.updateMember(memberId, { canOperate }, 'organization_members_operator_one_company_uq');
    await this.log(actorUserId, ctx.orgId, 'member.can_operate_changed', memberId, { canOperate });
    return toView(row, await this.users.getById(row.userId));
  }

  async setBlocked(ctx: OrgContext, actorUserId: string, memberId: string, blocked: boolean): Promise<MemberView> {
    const member = await this.getInOrg(ctx.orgId, memberId);
    this.assertCanManage(ctx, member);
    if (blocked && member.status !== 'active') {
      throw new AppException(ERROR_CODES.INVALID_STATUS_TRANSITION, 'Блокировать можно только активного сотрудника', HttpStatus.CONFLICT);
    }
    if (!blocked && member.status !== 'blocked') {
      throw new AppException(ERROR_CODES.INVALID_STATUS_TRANSITION, 'Сотрудник не заблокирован', HttpStatus.CONFLICT);
    }
    if (!blocked && member.canOperate) await this.assertNotOperatorElsewhere(member.userId, ctx.orgId);
    const row = await this.updateMember(memberId, { status: blocked ? 'blocked' : 'active' }, 'organization_members_operator_one_company_uq');
    await this.log(actorUserId, ctx.orgId, blocked ? 'member.blocked' : 'member.unblocked', memberId, null);
    return toView(row, await this.users.getById(row.userId));
  }

  /** Отвязка сотрудника руководителем (Р-15, П-11). Аккаунт и история сохраняются. */
  async detach(ctx: OrgContext, actorUserId: string, memberId: string): Promise<void> {
    const member = await this.getInOrg(ctx.orgId, memberId);
    this.assertCanManage(ctx, member);
    await this.detachMember(member, actorUserId);
  }

  /** Сотрудник сам прекращает сотрудничество (Р-15). Главный владелец уйти так не может (Р-12). */
  async leave(orgId: string, userId: string): Promise<void> {
    const [member] = await this.db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId), ne(organizationMembers.status, 'detached')));
    if (!member) throw new AppException(ERROR_CODES.NOT_A_MEMBER, 'Организация не найдена', HttpStatus.NOT_FOUND);
    if (member.role === 'owner') {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Главный владелец передаёт права только через поддержку', HttpStatus.FORBIDDEN);
    }
    await this.detachMember(member, userId);
  }

  async invitations(userId: string): Promise<InvitationView[]> {
    const rows = await this.db
      .select({ m: organizationMembers, orgName: organizations.name })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'invited')));
    return rows.map(({ m, orgName }) => ({
      memberId: m.id,
      orgId: m.orgId,
      orgName,
      role: m.role,
      invitedAt: m.updatedAt.toISOString(),
    }));
  }

  /** Принятие приглашения: машинист подтверждает привязку (Р-14) и может быть только в одной компании (П-10). */
  async respond(userId: string, memberId: string, accept: boolean): Promise<void> {
    const [member] = await this.db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.id, memberId), eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'invited')));
    if (!member) throw new AppException(ERROR_CODES.NOT_FOUND, 'Приглашение не найдено', HttpStatus.NOT_FOUND);
    if (!accept) {
      await this.updateMember(memberId, { status: 'detached', detachedAt: new Date(), detachedBy: userId });
      await this.log(userId, member.orgId, 'member.invitation_declined', memberId, null);
      return;
    }
    if (member.canOperate) await this.assertNotOperatorElsewhere(userId, member.orgId);
    await this.updateMember(memberId, { status: 'active', joinedAt: new Date() }, 'organization_members_operator_one_company_uq');
    await this.log(userId, member.orgId, 'member.invitation_accepted', memberId, null);
  }

  async getInOrg(orgId: string, memberId: string): Promise<MemberRow> {
    const [m] = await this.db
      .select()
      .from(organizationMembers)
      .where(and(eq(organizationMembers.id, memberId), eq(organizationMembers.orgId, orgId), ne(organizationMembers.status, 'detached')));
    if (!m) throw new AppException(ERROR_CODES.NOT_FOUND, 'Сотрудник не найден', HttpStatus.NOT_FOUND);
    return m;
  }

  private assertCanManage(ctx: OrgContext, member: MemberRow): void {
    if (member.role === 'owner') {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Главного владельца нельзя заблокировать или отвязать', HttpStatus.FORBIDDEN);
    }
    if (member.role === 'manager' && ctx.role !== 'owner') {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Руководителями управляет только главный владелец', HttpStatus.FORBIDDEN);
    }
  }

  private async detachMember(member: MemberRow, actorUserId: string): Promise<void> {
    if (member.canOperate && (await this.activeOrders.hasUnfinishedOrders(member.orgId, member.userId))) {
      throw new AppException(
        ERROR_CODES.MEMBER_HAS_ACTIVE_ORDERS,
        'Сначала замените машиниста в его незавершённых заказах',
        HttpStatus.CONFLICT,
      );
    }
    await this.updateMember(member.id, { status: 'detached', detachedAt: new Date(), detachedBy: actorUserId });
    await this.log(actorUserId, member.orgId, 'member.detached', member.id, { role: member.role });
  }

  private async assertNotOperatorElsewhere(userId: string, orgId: string): Promise<void> {
    const [other] = await this.db
      .select({ id: organizationMembers.id })
      .from(organizationMembers)
      .where(
        and(
          eq(organizationMembers.userId, userId),
          eq(organizationMembers.canOperate, true),
          eq(organizationMembers.status, 'active'),
          ne(organizationMembers.orgId, orgId),
        ),
      );
    if (other) throw this.operatorElsewhere();
  }

  private operatorElsewhere(): AppException {
    return new AppException(
      ERROR_CODES.OPERATOR_IN_OTHER_COMPANY,
      'Машинист уже работает в другой компании',
      HttpStatus.CONFLICT,
    );
  }

  private async updateMember(id: string, patch: Partial<typeof organizationMembers.$inferInsert>, uniqueConstraint?: string): Promise<MemberRow> {
    try {
      const [row] = await this.db
        .update(organizationMembers)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(eq(organizationMembers.id, id))
        .returning();
      if (!row) throw new AppException(ERROR_CODES.NOT_FOUND, 'Сотрудник не найден', HttpStatus.NOT_FOUND);
      return row;
    } catch (e) {
      if (uniqueConstraint && isUniqueViolation(e, uniqueConstraint)) throw this.operatorElsewhere();
      throw e;
    }
  }

  private async log(userId: string, orgId: string, action: string, memberId: string, details: unknown): Promise<void> {
    await this.db.insert(userActionLog).values({ userId, orgId, action, entity: 'organization_member', entityId: memberId, details });
  }
}

function toView(m: MemberRow, u: typeof users.$inferSelect): MemberView {
  return {
    id: m.id,
    userId: u.id,
    fullName: u.fullName,
    phone: u.phone,
    role: m.role,
    canOperate: m.canOperate,
    status: m.status,
    operatorVerification: m.operatorVerification,
    joinedAt: m.joinedAt?.toISOString() ?? null,
  };
}
