import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, type OrganizationStatus, type TransferOwnership } from '@kovsh/contracts';
import { and, asc, desc, eq, ilike, inArray, isNull, or, type SQL } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { normalizePhone } from '../auth/phone';
import { SessionService } from '../auth/session.service';
import { AppException } from '../common/app-exception';
import { DB, type Database } from '../database/database.module';
import {
  documents,
  documentTypes,
  files,
  organizationMembers,
  organizationOwnershipHistory,
  organizations,
  organizationStatusHistory,
  users,
} from '../database/schema';
import { DocumentsService } from '../organizations/documents.service';
import { MembersService } from '../organizations/members.service';
import { OrganizationsService } from '../organizations/organizations.service';
import { UsersService } from '../users/users.service';
import type { AuthAdmin } from './admin-auth.guard';

@Injectable()
export class ModerationService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly orgs: OrganizationsService,
    private readonly docs: DocumentsService,
    private readonly members: MembersService,
    private readonly users: UsersService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  // ── Организации ────────────────────────────────────────────────────────────

  async listOrganizations(status?: OrganizationStatus, q?: string) {
    const conds: SQL[] = [];
    if (status) conds.push(eq(organizations.status, status));
    if (q) {
      const like = `%${q}%`;
      const c = or(ilike(organizations.name, like), ilike(organizations.inn, like));
      if (c) conds.push(c);
    }
    return this.db
      .select()
      .from(organizations)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(status === 'pending_review' ? asc(organizations.submittedAt) : desc(organizations.createdAt))
      .limit(200);
  }

  async organizationCard(id: string) {
    const org = await this.orgs.get(id);
    const [memberList, documentList, history] = await Promise.all([
      this.members.list(id),
      this.docs.requirements('organization', id, org.legalForm),
      this.db.select().from(organizationStatusHistory).where(eq(organizationStatusHistory.orgId, id)).orderBy(asc(organizationStatusHistory.createdAt)),
    ]);
    return { organization: org, members: memberList, documents: documentList, documentFiles: await this.docs.list('organization', id), history };
  }

  /** Подтверждение организации: все обязательные документы должны быть одобрены модератором. */
  async approveOrganization(id: string, admin: AuthAdmin) {
    const org = await this.orgs.get(id);
    const reqs = await this.docs.requirements('organization', id, org.legalForm);
    const notApproved = reqs.filter((r) => r.required && r.status !== 'approved');
    if (notApproved.length > 0) {
      throw new AppException(ERROR_CODES.ORG_INCOMPLETE, 'Сначала проверьте все обязательные документы', HttpStatus.UNPROCESSABLE_ENTITY, {
        documents: notApproved.map((d) => ({ code: d.code, status: d.status })),
      });
    }
    return this.db.transaction(async (tx) => {
      const row = await this.orgs.transition(id, ['pending_review'], 'verified', { actorAdminId: admin.adminId }, { verifiedAt: new Date(), rejectionReason: null }, tx);
      await this.audit.log({ adminId: admin.adminId, action: 'organization.approve', entity: 'organization', entityId: id, before: { status: org.status }, after: { status: 'verified' }, ip: admin.ip }, tx);
      return row;
    });
  }

  async rejectOrganization(id: string, reason: string, admin: AuthAdmin) {
    return this.db.transaction(async (tx) => {
      const row = await this.orgs.transition(id, ['pending_review'], 'rejected', { actorAdminId: admin.adminId, reason }, { rejectionReason: reason }, tx);
      await this.audit.log({ adminId: admin.adminId, action: 'organization.reject', entity: 'organization', entityId: id, after: { status: 'rejected' }, reason, ip: admin.ip }, tx);
      return row;
    });
  }

  async blockOrganization(id: string, reason: string, admin: AuthAdmin) {
    return this.db.transaction(async (tx) => {
      const row = await this.orgs.transition(id, ['draft', 'pending_review', 'verified', 'rejected'], 'blocked', { actorAdminId: admin.adminId, reason }, { blockedReason: reason }, tx);
      await this.audit.log({ adminId: admin.adminId, action: 'organization.block', entity: 'organization', entityId: id, reason, ip: admin.ip }, tx);
      return row;
    });
  }

  /** Разблокировка возвращает организацию в «Подтверждена», если она была подтверждена, иначе в черновик. */
  async unblockOrganization(id: string, admin: AuthAdmin) {
    const org = await this.orgs.get(id);
    const to: OrganizationStatus = org.verifiedAt ? 'verified' : 'draft';
    return this.db.transaction(async (tx) => {
      const row = await this.orgs.transition(id, ['blocked'], to, { actorAdminId: admin.adminId }, { blockedReason: null }, tx);
      await this.audit.log({ adminId: admin.adminId, action: 'organization.unblock', entity: 'organization', entityId: id, after: { status: to }, ip: admin.ip }, tx);
      return row;
    });
  }

  /** Передача главного владения — только через поддержку, с документами-основаниями (Р-12). */
  async transferOwnership(orgId: string, dto: TransferOwnership, admin: AuthAdmin) {
    await this.orgs.get(orgId);
    const found = await this.db.select({ id: files.id }).from(files).where(inArray(files.id, dto.basisFileIds));
    if (found.length !== new Set(dto.basisFileIds).size) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Документы-основания не найдены', HttpStatus.BAD_REQUEST);
    }
    const { user: newOwner } = await this.users.findOrCreateByPhone(normalizePhone(dto.newOwnerPhone));
    return this.db.transaction(async (tx) => {
      const [owner] = await tx.select().from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.role, 'owner'))).for('update');
      if (!owner) throw new Error('У организации нет главного владельца');
      if (owner.userId === newOwner.id) {
        throw new AppException(ERROR_CODES.CONFLICT, 'Этот пользователь уже главный владелец', HttpStatus.CONFLICT);
      }
      // Прежний владелец остаётся руководителем; решение об отвязке принимает новый владелец.
      await tx.update(organizationMembers).set({ role: 'manager' }).where(eq(organizationMembers.id, owner.id));
      const [existing] = await tx.select().from(organizationMembers)
        .where(and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, newOwner.id)));
      if (existing) {
        await tx.update(organizationMembers)
          .set({ role: 'owner', status: 'active', joinedAt: existing.joinedAt ?? new Date(), detachedAt: null, detachedBy: null })
          .where(eq(organizationMembers.id, existing.id));
      } else {
        await tx.insert(organizationMembers).values({ orgId, userId: newOwner.id, role: 'owner', status: 'active', joinedAt: new Date() });
      }
      await tx.insert(organizationOwnershipHistory).values({
        orgId, fromUserId: owner.userId, toUserId: newOwner.id, adminId: admin.adminId, basisFileIds: dto.basisFileIds, reason: dto.reason,
      });
      await this.audit.log({
        adminId: admin.adminId, action: 'organization.transfer_ownership', entity: 'organization', entityId: orgId,
        before: { ownerUserId: owner.userId }, after: { ownerUserId: newOwner.id, basisFileIds: dto.basisFileIds }, reason: dto.reason, ip: admin.ip,
      }, tx);
      return { previousOwnerUserId: owner.userId, newOwnerUserId: newOwner.id };
    });
  }

  // ── Документы ──────────────────────────────────────────────────────────────

  async documentQueue(status: 'uploaded' | 'approved' | 'rejected' = 'uploaded') {
    return this.db
      .select({
        id: documents.id, ownerType: documents.ownerType, ownerId: documents.ownerId, fileId: documents.fileId,
        status: documents.status, typeCode: documentTypes.code, typeTitle: documentTypes.title, createdAt: documents.createdAt,
      })
      .from(documents)
      .innerJoin(documentTypes, eq(documentTypes.id, documents.documentTypeId))
      .where(and(eq(documents.status, status), isNull(documents.supersededAt)))
      .orderBy(asc(documents.createdAt))
      .limit(200);
  }

  async reviewDocument(id: string, decision: 'approved' | 'rejected', comment: string | null, admin: AuthAdmin) {
    const { d } = await this.docs.getById(id);
    if (d.supersededAt) throw new AppException(ERROR_CODES.CONFLICT, 'Документ заменён новой версией', HttpStatus.CONFLICT);
    if (decision === 'rejected' && !comment) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Укажите причину отклонения', HttpStatus.BAD_REQUEST);
    }
    await this.db.transaction(async (tx) => {
      await tx.update(documents)
        .set({ status: decision, reviewerAdminId: admin.adminId, reviewComment: comment, reviewedAt: new Date() })
        .where(eq(documents.id, id));
      await this.audit.log({
        adminId: admin.adminId, action: `document.${decision === 'approved' ? 'approve' : 'reject'}`, entity: 'document', entityId: id,
        before: { status: d.status }, after: { status: decision }, reason: comment, ip: admin.ip,
      }, tx);
    });
    if (d.ownerType === 'operator') await this.recalcOperatorVerification(d.ownerId);
    return this.docs.getById(id);
  }

  /** Статус проверки машиниста выводится из его документов (В-32). */
  async recalcOperatorVerification(memberId: string): Promise<void> {
    const reqs = await this.docs.requirements('operator', memberId);
    const required = reqs.filter((r) => r.required);
    let status: 'not_submitted' | 'pending' | 'approved' | 'rejected';
    if (required.some((r) => r.status === 'rejected')) status = 'rejected';
    else if (required.every((r) => r.status === 'approved')) status = 'approved';
    else if (required.every((r) => r.status !== 'missing')) status = 'pending';
    else status = 'not_submitted';
    await this.db.update(organizationMembers).set({ operatorVerification: status }).where(eq(organizationMembers.id, memberId));
  }

  // ── Пользователи ───────────────────────────────────────────────────────────

  async listUsers(phone?: string) {
    const where = phone ? ilike(users.phone, `%${phone.replace(/\D/g, '')}%`) : undefined;
    return this.db.select().from(users).where(where).orderBy(desc(users.createdAt)).limit(200);
  }

  async setUserBlocked(userId: string, blocked: boolean, reason: string | null, admin: AuthAdmin) {
    const user = await this.users.getById(userId);
    await this.db.transaction(async (tx) => {
      await tx.update(users).set({ status: blocked ? 'blocked' : 'active', blockedReason: blocked ? reason : null }).where(eq(users.id, userId));
      await this.audit.log({
        adminId: admin.adminId, action: blocked ? 'user.block' : 'user.unblock', entity: 'user', entityId: userId,
        before: { status: user.status }, after: { status: blocked ? 'blocked' : 'active' }, reason, ip: admin.ip,
      }, tx);
    });
    if (blocked) await this.sessions.revokeAllForUser(userId, 'user_blocked');
    return this.users.getById(userId);
  }
}
