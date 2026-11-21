import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type CreateUnit,
  type Schedule,
  type UnitVerificationStatus,
  type UpdateUnit,
  type UploadDocument,
} from '@kovsh/contracts';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { CatalogService } from '../catalog/catalog.service';
import { AppException } from '../common/app-exception';
import { DB, type Database } from '../database/database.module';
import {
  equipmentPhotos,
  equipmentSchedules,
  equipmentUnits,
  equipmentUnitStatusHistory,
  organizations,
  userActionLog,
} from '../database/schema';
import { FilesService } from '../files/files.service';
import { DocumentsService, type DocumentView, type RequirementView } from '../organizations/documents.service';

type UnitRow = typeof equipmentUnits.$inferSelect;
type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface UnitView {
  id: string;
  orgId: string;
  categoryId: string;
  categoryName: string;
  brand: string;
  model: string;
  year: number | null;
  regNumber: string | null;
  attributes: Record<string, unknown>;
  base: { lat: number; lng: number; address: string };
  workRadiusKm: number;
  allowBeyondRadius: boolean;
  isOnline: boolean;
  verificationStatus: UnitVerificationStatus;
  rejectionReason: string | null;
  archived: boolean;
  photos: { id: string; fileId: string; sort: number }[];
  schedule: { weekday: number; start: string; end: string }[];
  documents?: RequirementView[];
}

/** Поля, изменение которых у проверенной техники требует повторной проверки (С-10). */
const IDENTITY_FIELDS = ['categoryId', 'brand', 'model', 'year', 'regNumber'] as const;

@Injectable()
export class EquipmentService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly catalog: CatalogService,
    private readonly docs: DocumentsService,
    private readonly files: FilesService,
  ) {}

  async list(orgId: string, includeArchived = false): Promise<UnitView[]> {
    const rows = await this.db
      .select({ id: equipmentUnits.id })
      .from(equipmentUnits)
      .where(and(eq(equipmentUnits.orgId, orgId), includeArchived ? undefined : isNull(equipmentUnits.archivedAt)))
      .orderBy(asc(equipmentUnits.createdAt));
    return Promise.all(rows.map((r) => this.view(r.id, false)));
  }

  async create(orgId: string, userId: string, dto: CreateUnit): Promise<UnitView> {
    const cat = await this.catalog.assertUnitCategory(dto.categoryId);
    this.assertYear(cat.yearRequired, dto.year);
    const attributes = await this.catalog.validateAttributes(dto.categoryId, dto.attributes);
    const id = await this.uniqueReg(async () => {
      const [row] = await this.db
        .insert(equipmentUnits)
        .values({
          orgId, categoryId: dto.categoryId, brand: dto.brand, model: dto.model, year: dto.year ?? null,
          regNumber: normalizeReg(dto.regNumber), attributes, basePoint: point(dto.base.lat, dto.base.lng),
          baseAddress: dto.base.address, workRadiusKm: dto.workRadiusKm, allowBeyondRadius: dto.allowBeyondRadius, createdBy: userId,
        })
        .returning({ id: equipmentUnits.id });
      if (!row) throw new Error('Техника не сохранена');
      await this.db.insert(equipmentUnitStatusHistory).values({ unitId: row.id, toStatus: 'draft', actorUserId: userId });
      return row.id;
    });
    return this.view(id, true);
  }

  async update(orgId: string, unitId: string, userId: string, dto: UpdateUnit): Promise<UnitView> {
    const unit = await this.get(orgId, unitId);
    if (unit.archivedAt) throw new AppException(ERROR_CODES.CONFLICT, 'Техника в архиве', HttpStatus.CONFLICT);
    const categoryId = dto.categoryId ?? unit.categoryId;
    const cat = dto.categoryId ? await this.catalog.assertUnitCategory(categoryId) : await this.catalog.getCategory(categoryId);
    const year = dto.year !== undefined ? dto.year : unit.year;
    this.assertYear(cat.yearRequired, year);
    const attributes = dto.attributes !== undefined || dto.categoryId
      ? await this.catalog.validateAttributes(categoryId, dto.attributes ?? unit.attributes as Record<string, never>)
      : undefined;

    const identityChanged = IDENTITY_FIELDS.some((f) => {
      if (dto[f] === undefined) return false;
      const current = f === 'regNumber' ? unit.regNumber : unit[f];
      const next = f === 'regNumber' ? normalizeReg(dto.regNumber) : dto[f];
      return next !== current;
    });
    const resetVerification = identityChanged && (unit.verificationStatus === 'approved' || unit.verificationStatus === 'pending');

    await this.uniqueReg(async () => {
      await this.db.transaction(async (tx) => {
        await tx.update(equipmentUnits).set({
          ...(dto.categoryId !== undefined ? { categoryId } : {}),
          ...(dto.brand !== undefined ? { brand: dto.brand } : {}),
          ...(dto.model !== undefined ? { model: dto.model } : {}),
          ...(dto.year !== undefined ? { year: dto.year } : {}),
          ...(dto.regNumber !== undefined ? { regNumber: normalizeReg(dto.regNumber) } : {}),
          ...(attributes !== undefined ? { attributes } : {}),
          ...(dto.base ? { basePoint: point(dto.base.lat, dto.base.lng), baseAddress: dto.base.address } : {}),
          ...(dto.workRadiusKm !== undefined ? { workRadiusKm: dto.workRadiusKm } : {}),
          ...(dto.allowBeyondRadius !== undefined ? { allowBeyondRadius: dto.allowBeyondRadius } : {}),
          ...(resetVerification ? { isOnline: false } : {}),
        }).where(eq(equipmentUnits.id, unitId));
        if (resetVerification) {
          await this.transition(tx, unit, 'pending', { actorUserId: userId, reason: 'Изменены основные данные техники' }, { submittedAt: new Date() });
        }
      });
      return unitId;
    });
    return this.view(unitId, true);
  }

  async archive(orgId: string, unitId: string, userId: string): Promise<void> {
    const unit = await this.get(orgId, unitId);
    if (await this.hasFutureBookings(unitId)) {
      throw new AppException(ERROR_CODES.CONFLICT, 'У техники есть предстоящие заказы', HttpStatus.CONFLICT);
    }
    await this.db.update(equipmentUnits).set({ archivedAt: new Date(), isOnline: false }).where(eq(equipmentUnits.id, unit.id));
    await this.log(userId, orgId, 'equipment.archived', unitId, null);
  }

  /** Отправка на проверку администрацией: нужны обязательные документы техники. */
  async submit(orgId: string, unitId: string, userId: string): Promise<UnitView> {
    const unit = await this.get(orgId, unitId);
    if (unit.verificationStatus !== 'draft' && unit.verificationStatus !== 'rejected') {
      throw new AppException(ERROR_CODES.INVALID_STATUS_TRANSITION, 'Техника уже на проверке или проверена', HttpStatus.CONFLICT);
    }
    const reqs = await this.docs.requirements('equipment', unitId);
    const missing = reqs.filter((r) => r.required && ['missing', 'rejected', 'expired'].includes(r.status));
    if (missing.length > 0) {
      throw new AppException(ERROR_CODES.UNIT_INCOMPLETE, 'Загрузите обязательные документы', HttpStatus.UNPROCESSABLE_ENTITY, {
        missingDocuments: missing.map((m) => m.code),
      });
    }
    await this.db.transaction((tx) =>
      this.transition(tx, unit, 'pending', { actorUserId: userId }, { submittedAt: new Date(), rejectionReason: null }),
    );
    return this.view(unitId, true);
  }

  /** «На линии / Не на линии» (В-12). На линию — только проверенная техника подтверждённой организации. */
  async setOnline(orgId: string, unitId: string, userId: string, online: boolean): Promise<UnitView> {
    const unit = await this.get(orgId, unitId);
    if (online) {
      const [org] = await this.db.select({ status: organizations.status }).from(organizations).where(eq(organizations.id, orgId));
      if (org?.status !== 'verified') {
        throw new AppException(ERROR_CODES.ORG_NOT_VERIFIED, 'Организация ещё не прошла проверку', HttpStatus.CONFLICT);
      }
      if (unit.verificationStatus !== 'approved' || unit.archivedAt) {
        throw new AppException(ERROR_CODES.UNIT_NOT_APPROVED, 'Техника ещё не прошла проверку', HttpStatus.CONFLICT);
      }
      await this.catalog.assertUnitCategory(unit.categoryId);
    }
    await this.db.update(equipmentUnits).set({ isOnline: online }).where(eq(equipmentUnits.id, unitId));
    await this.log(userId, orgId, online ? 'equipment.online' : 'equipment.offline', unitId, null);
    return this.view(unitId, true);
  }

  async setSchedule(orgId: string, unitId: string, dto: Schedule): Promise<UnitView> {
    await this.get(orgId, unitId);
    const byDay = new Map<number, { start: string; end: string }[]>();
    for (const i of dto.intervals) {
      if (i.start >= i.end) {
        throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Начало интервала должно быть раньше конца', HttpStatus.BAD_REQUEST);
      }
      const list = byDay.get(i.weekday) ?? [];
      if (list.some((x) => i.start < x.end && x.start < i.end)) {
        throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Интервалы одного дня пересекаются', HttpStatus.BAD_REQUEST);
      }
      byDay.set(i.weekday, [...list, i]);
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(equipmentSchedules).where(eq(equipmentSchedules.unitId, unitId));
      if (dto.intervals.length > 0) {
        await tx.insert(equipmentSchedules).values(
          dto.intervals.map((i) => ({ unitId, weekday: i.weekday, startTime: i.start, endTime: i.end })),
        );
      }
    });
    return this.view(unitId, true);
  }

  async addPhoto(orgId: string, unitId: string, userId: string, fileId: string): Promise<UnitView> {
    await this.get(orgId, unitId);
    const file = await this.files.getMeta(fileId);
    if (file.uploadedByUserId !== userId || !file.mime.startsWith('image/')) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Нужна фотография, загруженная вами', HttpStatus.BAD_REQUEST);
    }
    const [{ n } = { n: 0 }] = (await this.db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM equipment_photos WHERE unit_id = ${unitId}`)).rows;
    if (n >= 20) throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Не больше 20 фотографий', HttpStatus.BAD_REQUEST);
    await this.db.insert(equipmentPhotos).values({ unitId, fileId, sort: n }).onConflictDoNothing();
    return this.view(unitId, true);
  }

  async removePhoto(orgId: string, unitId: string, photoId: string): Promise<UnitView> {
    await this.get(orgId, unitId);
    await this.db.delete(equipmentPhotos).where(and(eq(equipmentPhotos.id, photoId), eq(equipmentPhotos.unitId, unitId)));
    return this.view(unitId, true);
  }

  async documents(orgId: string, unitId: string): Promise<{ requirements: RequirementView[]; documents: DocumentView[] }> {
    await this.get(orgId, unitId);
    const [requirements, documents] = await Promise.all([this.docs.requirements('equipment', unitId), this.docs.list('equipment', unitId)]);
    return { requirements, documents };
  }

  async uploadDocument(orgId: string, unitId: string, userId: string, dto: UploadDocument): Promise<DocumentView> {
    await this.get(orgId, unitId);
    return this.docs.upload('equipment', unitId, dto, userId);
  }

  /** Календарь занятости (В-12): брони под заказы и рабочее расписание. */
  async calendar(orgId: string, unitId: string, from: Date, to: Date) {
    const unit = await this.view(unitId, false, orgId);
    const res = await this.db.execute<{ id: string; order_id: string | null; starts_at: Date; ends_at: Date }>(sql`
      SELECT id, order_id, lower(period) AS starts_at, upper(period) AS ends_at FROM unit_bookings
      WHERE unit_id = ${unitId} AND status = 'active' AND period && tstzrange(${from.toISOString()}, ${to.toISOString()})
      ORDER BY lower(period)`);
    return {
      schedule: unit.schedule,
      bookings: res.rows.map((b) => ({ id: b.id, orderId: b.order_id, start: new Date(b.starts_at).toISOString(), end: new Date(b.ends_at).toISOString() })),
    };
  }

  // ── Модерация (вызывается из админки) ─────────────────────────────────────
  async moderationQueue(status: UnitVerificationStatus = 'pending') {
    const rows = await this.db
      .select({ id: equipmentUnits.id })
      .from(equipmentUnits)
      .where(and(eq(equipmentUnits.verificationStatus, status), isNull(equipmentUnits.archivedAt)))
      .orderBy(asc(equipmentUnits.submittedAt))
      .limit(200);
    return Promise.all(rows.map((r) => this.view(r.id, true)));
  }

  async review(unitId: string, decision: 'approved' | 'rejected', reason: string | null, adminId: string): Promise<UnitView> {
    const [unit] = await this.db.select().from(equipmentUnits).where(eq(equipmentUnits.id, unitId));
    if (!unit) throw new AppException(ERROR_CODES.NOT_FOUND, 'Техника не найдена', HttpStatus.NOT_FOUND);
    if (decision === 'approved') {
      const reqs = await this.docs.requirements('equipment', unitId);
      const notApproved = reqs.filter((r) => r.required && r.status !== 'approved');
      if (notApproved.length > 0) {
        throw new AppException(ERROR_CODES.UNIT_INCOMPLETE, 'Сначала проверьте обязательные документы техники', HttpStatus.UNPROCESSABLE_ENTITY, {
          documents: notApproved.map((d) => ({ code: d.code, status: d.status })),
        });
      }
    }
    await this.db.transaction((tx) =>
      this.transition(tx, unit, decision, { actorAdminId: adminId, reason: reason ?? undefined },
        decision === 'approved' ? { verifiedAt: new Date(), rejectionReason: null } : { rejectionReason: reason, isOnline: false }),
    );
    return this.view(unitId, true);
  }

  async forceOffline(unitId: string): Promise<void> {
    await this.db.update(equipmentUnits).set({ isOnline: false }).where(eq(equipmentUnits.id, unitId));
  }

  // ── Внутреннее ────────────────────────────────────────────────────────────
  async get(orgId: string, unitId: string): Promise<UnitRow> {
    const [u] = await this.db.select().from(equipmentUnits).where(and(eq(equipmentUnits.id, unitId), eq(equipmentUnits.orgId, orgId)));
    if (!u) throw new AppException(ERROR_CODES.NOT_FOUND, 'Техника не найдена', HttpStatus.NOT_FOUND);
    return u;
  }

  async view(unitId: string, withDocuments: boolean, orgId?: string): Promise<UnitView> {
    const res = await this.db.execute<UnitRow & { lat: number; lng: number; category_name: string }>(sql`
      SELECT u.*, ST_Y(u.base_point::geometry) AS lat, ST_X(u.base_point::geometry) AS lng, c.name AS category_name
      FROM equipment_units u JOIN equipment_categories c ON c.id = u.category_id
      WHERE u.id = ${unitId} ${orgId ? sql`AND u.org_id = ${orgId}` : sql``}`);
    const r = res.rows[0] as unknown as Record<string, unknown> | undefined;
    if (!r) throw new AppException(ERROR_CODES.NOT_FOUND, 'Техника не найдена', HttpStatus.NOT_FOUND);
    const [photos, schedule] = await Promise.all([
      this.db.select().from(equipmentPhotos).where(eq(equipmentPhotos.unitId, unitId)).orderBy(asc(equipmentPhotos.sort)),
      this.db.select().from(equipmentSchedules).where(eq(equipmentSchedules.unitId, unitId)).orderBy(asc(equipmentSchedules.weekday), asc(equipmentSchedules.startTime)),
    ]);
    const view: UnitView = {
      id: String(r['id']), orgId: String(r['org_id']), categoryId: String(r['category_id']), categoryName: String(r['category_name']),
      brand: String(r['brand']), model: String(r['model']), year: (r['year'] as number | null) ?? null,
      regNumber: (r['reg_number'] as string | null) ?? null, attributes: r['attributes'] as Record<string, unknown>,
      base: { lat: Number(r['lat']), lng: Number(r['lng']), address: String(r['base_address']) },
      workRadiusKm: Number(r['work_radius_km']), allowBeyondRadius: Boolean(r['allow_beyond_radius']),
      isOnline: Boolean(r['is_online']), verificationStatus: r['verification_status'] as UnitVerificationStatus,
      rejectionReason: (r['rejection_reason'] as string | null) ?? null, archived: r['archived_at'] !== null,
      photos: photos.map((p) => ({ id: p.id, fileId: p.fileId, sort: p.sort })),
      schedule: schedule.map((s) => ({ weekday: s.weekday, start: s.startTime.slice(0, 5), end: s.endTime.slice(0, 5) })),
    };
    if (withDocuments) view.documents = await this.docs.requirements('equipment', unitId);
    return view;
  }

  private async transition(
    tx: Tx,
    unit: UnitRow,
    to: UnitVerificationStatus,
    actor: { actorUserId?: string; actorAdminId?: string; reason?: string | undefined },
    patch: Partial<typeof equipmentUnits.$inferInsert> = {},
  ): Promise<void> {
    const [row] = await tx
      .update(equipmentUnits)
      .set({ ...patch, verificationStatus: to })
      .where(and(eq(equipmentUnits.id, unit.id), eq(equipmentUnits.verificationStatus, unit.verificationStatus)))
      .returning({ id: equipmentUnits.id });
    if (!row) throw new AppException(ERROR_CODES.CONFLICT, 'Статус техники изменился, повторите', HttpStatus.CONFLICT);
    await tx.insert(equipmentUnitStatusHistory).values({
      unitId: unit.id, fromStatus: unit.verificationStatus, toStatus: to, reason: actor.reason ?? null,
      actorUserId: actor.actorUserId ?? null, actorAdminId: actor.actorAdminId ?? null,
    });
  }

  private assertYear(required: boolean, year: number | null | undefined): void {
    if (required && (year === null || year === undefined)) {
      throw new AppException(ERROR_CODES.INVALID_ATTRIBUTES, 'Укажите год выпуска', HttpStatus.BAD_REQUEST, [{ key: 'year', message: 'обязательно' }]);
    }
  }

  private async hasFutureBookings(unitId: string): Promise<boolean> {
    const res = await this.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM unit_bookings WHERE unit_id = ${unitId} AND status = 'active' AND upper(period) > now()`);
    return (res.rows[0]?.n ?? 0) > 0;
  }

  private async uniqueReg<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const c = (e as { cause?: { code?: string; constraint?: string } }).cause ?? (e as { code?: string; constraint?: string });
      if (c.code === '23505' && c.constraint === 'equipment_units_reg_number_uq') {
        throw new AppException(ERROR_CODES.CONFLICT, 'Техника с таким госномером уже зарегистрирована', HttpStatus.CONFLICT);
      }
      throw e;
    }
  }

  private async log(userId: string, orgId: string, action: string, unitId: string, details: unknown): Promise<void> {
    await this.db.insert(userActionLog).values({ userId, orgId, action, entity: 'equipment_unit', entityId: unitId, details });
  }
}

const point = (lat: number, lng: number) => sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography` as unknown as string;
const normalizeReg = (v: string | null | undefined): string | null =>
  v ? v.toUpperCase().replace(/\s+/g, '') : null;

