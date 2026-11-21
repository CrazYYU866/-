import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type CreateOrganization,
  type OrgMemberRole,
  type OrganizationStatus,
  type UpdateOrganization,
} from '@kovsh/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { normalizePhone } from '../auth/phone';
import { AppException } from '../common/app-exception';
import { DB, type Database } from '../database/database.module';
import {
  organizationBankAccounts,
  organizationMembers,
  organizations,
  organizationStatusHistory,
} from '../database/schema';
import { DocumentsService, type RequirementView } from './documents.service';
import { isValidInn, isValidOgrn } from './requisites';

export type OrgRow = typeof organizations.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface OrganizationView {
  id: string;
  kind: 'partner' | 'agent';
  legalForm: string;
  name: string;
  representativeName: string;
  inn: string;
  ogrn: string;
  kpp: string | null;
  legalAddress: string;
  email: string;
  contactPhone: string;
  status: OrganizationStatus;
  rejectionReason: string | null;
  blockedReason: string | null;
  verifiedAt: string | null;
  myRole: OrgMemberRole;
  bankAccount?: { bik: string; bankName: string; accountLast4: string } | null;
  documents?: RequirementView[];
}

export interface MembershipView {
  orgId: string;
  name: string;
  kind: 'partner' | 'agent';
  status: OrganizationStatus;
  role: OrgMemberRole;
  canOperate: boolean;
}

/** Ограничения формы: ИП — ИНН 12 / ОГРНИП 15, юрлицо — ИНН 10 / ОГРН 13; контрольные числа ФНС. */
export function assertRequisites(legalForm: string, inn: string, ogrn: string): void {
  const ip = legalForm === 'ip';
  if (!isValidInn(inn) || inn.length !== (ip ? 12 : 10)) {
    throw new AppException(ERROR_CODES.INVALID_INN, ip ? 'ИНН ИП — 12 цифр, проверьте номер' : 'ИНН организации — 10 цифр, проверьте номер', HttpStatus.BAD_REQUEST);
  }
  if (!isValidOgrn(ogrn) || ogrn.length !== (ip ? 15 : 13)) {
    throw new AppException(ERROR_CODES.INVALID_OGRN, ip ? 'ОГРНИП — 15 цифр, проверьте номер' : 'ОГРН — 13 цифр, проверьте номер', HttpStatus.BAD_REQUEST);
  }
}

@Injectable()
export class OrganizationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly docs: DocumentsService,
  ) {}

  async create(userId: string, dto: CreateOrganization): Promise<OrgRow> {
    assertRequisites(dto.legalForm, dto.inn, dto.ogrn);
    const contactPhone = normalizePhone(dto.contactPhone);
    return this.db.transaction(async (tx) => {
      const [org] = await tx
        .insert(organizations)
        .values({ ...dto, kpp: dto.kpp ?? null, contactPhone, createdBy: userId })
        .onConflictDoNothing()
        .returning();
      if (!org) {
        throw new AppException(ERROR_CODES.ORG_ALREADY_EXISTS, 'Организация с таким ИНН уже зарегистрирована', HttpStatus.CONFLICT);
      }
      await tx.insert(organizationMembers).values({
        orgId: org.id,
        userId,
        role: 'owner',
        status: 'active',
        joinedAt: new Date(),
      });
      await tx.insert(organizationStatusHistory).values({ orgId: org.id, toStatus: 'draft', actorUserId: userId });
      return org;
    });
  }

  async get(orgId: string): Promise<OrgRow> {
    const [org] = await this.db.select().from(organizations).where(eq(organizations.id, orgId));
    if (!org) throw new AppException(ERROR_CODES.NOT_FOUND, 'Организация не найдена', HttpStatus.NOT_FOUND);
    return org;
  }

  async view(orgId: string, role: OrgMemberRole): Promise<OrganizationView> {
    const org = await this.get(orgId);
    const base: OrganizationView = {
      id: org.id,
      kind: org.kind,
      legalForm: org.legalForm,
      name: org.name,
      representativeName: org.representativeName,
      inn: org.inn,
      ogrn: org.ogrn,
      kpp: org.kpp,
      legalAddress: org.legalAddress,
      email: org.email,
      contactPhone: org.contactPhone,
      status: org.status,
      rejectionReason: org.rejectionReason,
      blockedReason: org.blockedReason,
      verifiedAt: org.verifiedAt?.toISOString() ?? null,
      myRole: role,
    };
    // Реквизиты и документы компании видят только руководители (Р-1, Р-10).
    if (role === 'owner' || role === 'manager') {
      const [bank] = await this.db
        .select()
        .from(organizationBankAccounts)
        .where(and(eq(organizationBankAccounts.orgId, orgId), eq(organizationBankAccounts.isCurrent, true)));
      base.bankAccount = bank ? { bik: bank.bik, bankName: bank.bankName, accountLast4: bank.accountNumberLast4 } : null;
      base.documents = await this.docs.requirements('organization', orgId, org.legalForm);
    }
    return base;
  }

  /** Реквизиты редактируются только до проверки или после отклонения. */
  async update(orgId: string, dto: UpdateOrganization): Promise<OrgRow> {
    const org = await this.get(orgId);
    if (org.status !== 'draft' && org.status !== 'rejected') {
      throw new AppException(
        ERROR_CODES.ORG_NOT_EDITABLE,
        'Данные проверенной организации меняются через поддержку',
        HttpStatus.CONFLICT,
      );
    }
    const next = { ...org, ...dto };
    assertRequisites(next.legalForm, next.inn, next.ogrn);
    const patch: Partial<typeof organizations.$inferInsert> = { ...dto };
    if (dto.contactPhone) patch.contactPhone = normalizePhone(dto.contactPhone);
    const [row] = await this.db.update(organizations).set(patch).where(eq(organizations.id, orgId)).returning();
    if (!row) throw new AppException(ERROR_CODES.NOT_FOUND, 'Организация не найдена', HttpStatus.NOT_FOUND);
    return row;
  }

  /** Отправка на проверку: нужны обязательные документы и банковские реквизиты (ТЗ §3). */
  async submit(orgId: string, userId: string): Promise<OrgRow> {
    const org = await this.get(orgId);
    if (org.status !== 'draft' && org.status !== 'rejected') {
      throw new AppException(ERROR_CODES.INVALID_STATUS_TRANSITION, 'Организация уже на проверке или проверена', HttpStatus.CONFLICT);
    }
    const reqs = await this.docs.requirements('organization', orgId, org.legalForm);
    const missingDocs = reqs.filter((r) => r.required && (r.status === 'missing' || r.status === 'rejected' || r.status === 'expired'));
    const [bank] = await this.db
      .select({ id: organizationBankAccounts.id })
      .from(organizationBankAccounts)
      .where(and(eq(organizationBankAccounts.orgId, orgId), eq(organizationBankAccounts.isCurrent, true)));
    if (missingDocs.length > 0 || !bank) {
      throw new AppException(ERROR_CODES.ORG_INCOMPLETE, 'Заполните все обязательные данные', HttpStatus.UNPROCESSABLE_ENTITY, {
        missingDocuments: missingDocs.map((d) => d.code),
        missingBankAccount: !bank,
      });
    }
    return this.transition(orgId, ['draft', 'rejected'], 'pending_review', { actorUserId: userId }, { submittedAt: new Date(), rejectionReason: null });
  }

  async memberships(userId: string): Promise<MembershipView[]> {
    const rows = await this.db
      .select({
        orgId: organizations.id,
        name: organizations.name,
        kind: organizations.kind,
        status: organizations.status,
        role: organizationMembers.role,
        canOperate: organizationMembers.canOperate,
      })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.orgId))
      .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.status, 'active')));
    return rows;
  }

  /** Смена статуса с проверкой исходного состояния и записью истории в одной транзакции. */
  async transition(
    orgId: string,
    from: OrganizationStatus[],
    to: OrganizationStatus,
    actor: { actorUserId?: string; actorAdminId?: string; reason?: string },
    patch: Partial<typeof organizations.$inferInsert> = {},
    tx?: Tx,
  ): Promise<OrgRow> {
    const run = async (t: Tx) => {
      const [current] = await t.select().from(organizations).where(eq(organizations.id, orgId)).for('update');
      if (!current) throw new AppException(ERROR_CODES.NOT_FOUND, 'Организация не найдена', HttpStatus.NOT_FOUND);
      if (!from.includes(current.status)) {
        throw new AppException(
          ERROR_CODES.INVALID_STATUS_TRANSITION,
          `Нельзя перевести организацию из статуса «${current.status}» в «${to}»`,
          HttpStatus.CONFLICT,
        );
      }
      const [row] = await t
        .update(organizations)
        .set({ ...patch, status: to })
        .where(and(eq(organizations.id, orgId), inArray(organizations.status, from)))
        .returning();
      if (!row) throw new AppException(ERROR_CODES.CONFLICT, 'Статус изменился, повторите', HttpStatus.CONFLICT);
      await t.insert(organizationStatusHistory).values({
        orgId,
        fromStatus: current.status,
        toStatus: to,
        reason: actor.reason ?? null,
        actorUserId: actor.actorUserId ?? null,
        actorAdminId: actor.actorAdminId ?? null,
      });
      return row;
    };
    return tx ? run(tx) : this.db.transaction(run);
  }
}
