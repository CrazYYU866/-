import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import {
  ERROR_CODES,
  type CreateAttribute,
  type CreateCategory,
  type CreateRegion,
  type CreateTariff,
  type ImportZone,
  type MeasureUnitInput,
  type TariffKind,
  type UpdateAttribute,
  type UpdateCategory,
} from '@kovsh/contracts';
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { AuthAdmin } from '../admin/admin-auth.guard';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/app-exception';
import { DB, type Database } from '../database/database.module';
import {
  adminAuditLog,
  categoryAttributes,
  equipmentCategories,
  equipmentUnits,
  measureUnits,
  regions,
  serviceZones,
  tariffs,
} from '../database/schema';
import { CatalogService } from './catalog.service';

const notFound = (what: string) => new AppException(ERROR_CODES.NOT_FOUND, `${what} не найден(а)`, HttpStatus.NOT_FOUND);
const isUnique = (e: unknown) => ((e as { cause?: { code?: string }; code?: string }).cause ?? (e as { code?: string })).code === '23505';

/** Управление каталогом из админки без изменения кода (этап 4, п. 7). Каждое изменение пишется в журнал. */
@Injectable()
export class CatalogAdminService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly catalog: CatalogService,
    private readonly audit: AuditService,
  ) {}

  // ── Категории ───────────────────────────────────────────────────────────────
  async createCategory(dto: CreateCategory, admin: AuthAdmin) {
    if (dto.parentId) await this.catalog.getCategory(dto.parentId);
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(equipmentCategories).values({
          parentId: dto.parentId ?? null, slug: dto.slug, name: dto.name, description: dto.description ?? null,
          imageFileId: dto.imageFileId ?? null, yearRequired: dto.yearRequired, visibleToCustomers: dto.visibleToCustomers,
          visibleToPartners: dto.visibleToPartners, sort: dto.sort,
        }).returning();
        if (!row) throw new Error('Категория не создана');
        await this.audit.log({ adminId: admin.adminId, action: 'catalog.category.create', entity: 'category', entityId: row.id, after: row, ip: admin.ip }, tx);
        return row;
      });
    } catch (e) {
      if (isUnique(e)) throw new AppException(ERROR_CODES.CONFLICT, 'Категория с таким кодом уже есть', HttpStatus.CONFLICT);
      throw e;
    }
  }

  async updateCategory(id: string, dto: UpdateCategory, admin: AuthAdmin) {
    const before = await this.catalog.getCategory(id);
    if (dto.parentId) {
      const chain = await this.catalog.ancestors(dto.parentId);
      if (chain.some((c) => c.id === id)) {
        throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Категорию нельзя вложить саму в себя', HttpStatus.BAD_REQUEST);
      }
      if (await this.hasUnits(dto.parentId)) {
        throw new AppException(ERROR_CODES.CATEGORY_IN_USE, 'В новой родительской категории уже есть техника', HttpStatus.CONFLICT);
      }
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(equipmentCategories).set(dto).where(eq(equipmentCategories.id, id)).returning();
      await this.audit.log({ adminId: admin.adminId, action: 'catalog.category.update', entity: 'category', entityId: id, before, after: row, ip: admin.ip }, tx);
      return row;
    });
  }

  /** Архив: категория скрывается в приложениях, история и техника сохраняются. */
  async setCategoryArchived(id: string, archived: boolean, admin: AuthAdmin) {
    const before = await this.catalog.getCategory(id);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(equipmentCategories).set({ archivedAt: archived ? new Date() : null }).where(eq(equipmentCategories.id, id)).returning();
      if (archived) {
        // Техника архивной категории снимается с линии.
        await tx.execute(sql`
          UPDATE equipment_units SET is_online = false WHERE is_online AND category_id IN (
            WITH RECURSIVE sub AS (SELECT id FROM equipment_categories WHERE id = ${id}
              UNION ALL SELECT c.id FROM equipment_categories c JOIN sub ON c.parent_id = sub.id) SELECT id FROM sub)`);
      }
      await this.audit.log({ adminId: admin.adminId, action: archived ? 'catalog.category.archive' : 'catalog.category.unarchive', entity: 'category', entityId: id, before: { archivedAt: before.archivedAt }, after: { archivedAt: row?.archivedAt ?? null }, ip: admin.ip }, tx);
      return row;
    });
  }

  /** Удаление — только если категория нигде не использовалась. Иначе — архив. */
  async deleteCategory(id: string, admin: AuthAdmin) {
    const before = await this.catalog.getCategory(id);
    const [child] = await this.db.select({ id: equipmentCategories.id }).from(equipmentCategories).where(eq(equipmentCategories.parentId, id)).limit(1);
    const [tariff] = await this.db.select({ id: tariffs.id }).from(tariffs).where(eq(tariffs.categoryId, id)).limit(1);
    if (child || tariff || (await this.hasUnits(id))) {
      throw new AppException(ERROR_CODES.CATEGORY_IN_USE, 'Категория используется (подкатегории, тарифы или техника). Отправьте её в архив.', HttpStatus.CONFLICT);
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(categoryAttributes).where(eq(categoryAttributes.categoryId, id));
      await tx.delete(equipmentCategories).where(eq(equipmentCategories.id, id));
      await this.audit.log({ adminId: admin.adminId, action: 'catalog.category.delete', entity: 'category', entityId: id, before, ip: admin.ip }, tx);
    });
  }

  // ── Характеристики ─────────────────────────────────────────────────────────
  async createAttribute(categoryId: string, dto: CreateAttribute, admin: AuthAdmin) {
    await this.catalog.getCategory(categoryId);
    const existing = await this.catalog.effectiveAttributes(categoryId);
    if (existing.some((a) => a.key === dto.key)) {
      throw new AppException(ERROR_CODES.CONFLICT, 'Характеристика с таким кодом уже есть в этой категории или её родителях', HttpStatus.CONFLICT);
    }
    const unitId = await this.unitId(dto.unitCode);
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(categoryAttributes).values({
        categoryId, key: dto.key, label: dto.label, type: dto.type, unitId, options: dto.options ?? null,
        required: dto.required, filterable: dto.filterable, minValue: dto.minValue ?? null, maxValue: dto.maxValue ?? null, sort: dto.sort,
      }).returning();
      await this.audit.log({ adminId: admin.adminId, action: 'catalog.attribute.create', entity: 'attribute', entityId: row?.id ?? null, after: row, ip: admin.ip }, tx);
      return row;
    });
  }

  async updateAttribute(id: string, dto: UpdateAttribute, admin: AuthAdmin) {
    const before = await this.getAttribute(id);
    const patch: Partial<typeof categoryAttributes.$inferInsert> = {
      ...(dto.label !== undefined ? { label: dto.label } : {}),
      ...(dto.required !== undefined ? { required: dto.required } : {}),
      ...(dto.filterable !== undefined ? { filterable: dto.filterable } : {}),
      ...(dto.minValue !== undefined ? { minValue: dto.minValue } : {}),
      ...(dto.maxValue !== undefined ? { maxValue: dto.maxValue } : {}),
      ...(dto.sort !== undefined ? { sort: dto.sort } : {}),
    };
    if (dto.unitCode !== undefined) patch.unitId = await this.unitId(dto.unitCode);
    if (dto.options !== undefined) {
      const isList = before.type === 'enum' || before.type === 'multi_enum';
      if (!isList || !dto.options?.length) {
        throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Варианты задаются только для списков', HttpStatus.BAD_REQUEST);
      }
      patch.options = dto.options;
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(categoryAttributes).set(patch).where(eq(categoryAttributes.id, id)).returning();
      await this.audit.log({ adminId: admin.adminId, action: 'catalog.attribute.update', entity: 'attribute', entityId: id, before, after: row, ip: admin.ip }, tx);
      return row;
    });
  }

  /** Удаление характеристики: если значения уже заполнены у техники — в архив (значения сохраняются), иначе удаляется. */
  async removeAttribute(id: string, admin: AuthAdmin): Promise<{ result: 'deleted' | 'archived' }> {
    const before = await this.getAttribute(id);
    const used = await this.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM equipment_units WHERE attributes ? ${before.key} AND category_id IN (
        WITH RECURSIVE sub AS (SELECT id FROM equipment_categories WHERE id = ${before.categoryId}
          UNION ALL SELECT c.id FROM equipment_categories c JOIN sub ON c.parent_id = sub.id) SELECT id FROM sub)`);
    const inUse = (used.rows[0]?.n ?? 0) > 0;
    await this.db.transaction(async (tx) => {
      if (inUse) await tx.update(categoryAttributes).set({ archivedAt: new Date() }).where(eq(categoryAttributes.id, id));
      else await tx.delete(categoryAttributes).where(eq(categoryAttributes.id, id));
      await this.audit.log({ adminId: admin.adminId, action: inUse ? 'catalog.attribute.archive' : 'catalog.attribute.delete', entity: 'attribute', entityId: id, before, ip: admin.ip }, tx);
    });
    return { result: inUse ? 'archived' : 'deleted' };
  }

  // ── Единицы измерения ──────────────────────────────────────────────────────
  listUnits() {
    return this.db.select().from(measureUnits).orderBy(asc(measureUnits.name));
  }

  async createUnit(dto: MeasureUnitInput, admin: AuthAdmin) {
    try {
      const [row] = await this.db.insert(measureUnits).values(dto).returning();
      await this.audit.log({ adminId: admin.adminId, action: 'catalog.unit.create', entity: 'measure_unit', entityId: row?.id ?? null, after: row, ip: admin.ip });
      return row;
    } catch (e) {
      if (isUnique(e)) throw new AppException(ERROR_CODES.CONFLICT, 'Единица с таким кодом уже есть', HttpStatus.CONFLICT);
      throw e;
    }
  }

  async updateUnit(id: string, dto: Partial<MeasureUnitInput>, admin: AuthAdmin) {
    const [before] = await this.db.select().from(measureUnits).where(eq(measureUnits.id, id));
    if (!before) throw notFound('Единица измерения');
    const { code: _ignored, ...patch } = dto;
    const [row] = await this.db.update(measureUnits).set(patch).where(eq(measureUnits.id, id)).returning();
    await this.audit.log({ adminId: admin.adminId, action: 'catalog.unit.update', entity: 'measure_unit', entityId: id, before, after: row, ip: admin.ip });
    return row;
  }

  // ── Регионы и зоны ────────────────────────────────────────────────────────
  async createRegion(dto: CreateRegion, admin: AuthAdmin) {
    this.assertTimezone(dto.timezone);
    try {
      const [row] = await this.db.insert(regions).values(dto).returning();
      await this.audit.log({ adminId: admin.adminId, action: 'region.create', entity: 'region', entityId: row?.id ?? null, after: row, ip: admin.ip });
      return row;
    } catch (e) {
      if (isUnique(e)) throw new AppException(ERROR_CODES.CONFLICT, 'Регион с таким кодом уже есть', HttpStatus.CONFLICT);
      throw e;
    }
  }

  async updateRegion(id: string, dto: Partial<CreateRegion>, admin: AuthAdmin) {
    const [before] = await this.db.select().from(regions).where(eq(regions.id, id));
    if (!before) throw notFound('Регион');
    if (dto.timezone) this.assertTimezone(dto.timezone);
    const { code: _ignored, ...patch } = dto;
    const [row] = await this.db.update(regions).set(patch).where(eq(regions.id, id)).returning();
    await this.audit.log({ adminId: admin.adminId, action: 'region.update', entity: 'region', entityId: id, before, after: row, ip: admin.ip });
    return row;
  }

  /** Импорт границ региона из GeoJSON (Polygon / MultiPolygon / Feature / FeatureCollection). */
  async importZone(regionId: string, dto: ImportZone, admin: AuthAdmin) {
    const [region] = await this.db.select().from(regions).where(eq(regions.id, regionId));
    if (!region) throw notFound('Регион');
    const geometries = this.extractPolygons(dto.geojson);
    if (geometries.length === 0) {
      throw new AppException(ERROR_CODES.INVALID_GEOMETRY, 'В GeoJSON нет полигонов', HttpStatus.BAD_REQUEST);
    }
    const collection = JSON.stringify({ type: 'GeometryCollection', geometries });
    try {
      const res = await this.db.execute<{ id: string; area_km2: number }>(sql`
        INSERT INTO service_zones (region_id, name, area)
        SELECT ${regionId}, ${dto.name},
          ST_Multi(ST_CollectionExtract(ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(${collection}), 4326)), 3))::geography
        RETURNING id, (ST_Area(area) / 1e6)::float AS area_km2`);
      const row = res.rows[0];
      await this.audit.log({ adminId: admin.adminId, action: 'region.zone.import', entity: 'region', entityId: regionId, after: { zoneId: row?.id, name: dto.name, areaKm2: row?.area_km2 }, ip: admin.ip });
      return { id: row?.id, name: dto.name, areaKm2: Math.round(row?.area_km2 ?? 0) };
    } catch (e) {
      if (e instanceof AppException) throw e;
      throw new AppException(ERROR_CODES.INVALID_GEOMETRY, 'Некорректная геометрия', HttpStatus.BAD_REQUEST);
    }
  }

  async listZones(regionId: string) {
    const res = await this.db.execute(sql`
      SELECT id, name, active, (ST_Area(area) / 1e6)::int AS area_km2, created_at FROM service_zones WHERE region_id = ${regionId} ORDER BY created_at`);
    return res.rows;
  }

  async setZoneActive(zoneId: string, active: boolean, admin: AuthAdmin) {
    const [row] = await this.db.update(serviceZones).set({ active }).where(eq(serviceZones.id, zoneId)).returning({ id: serviceZones.id, regionId: serviceZones.regionId });
    if (!row) throw notFound('Зона');
    await this.audit.log({ adminId: admin.adminId, action: active ? 'region.zone.enable' : 'region.zone.disable', entity: 'region', entityId: row.regionId, after: { zoneId, active }, ip: admin.ip });
    return { id: zoneId, active };
  }

  // ── Тарифы ────────────────────────────────────────────────────────────────
  async listTariffs(filter: { categoryId?: string; regionId?: string; kind?: TariffKind }) {
    const conds: SQL[] = [];
    if (filter.categoryId) conds.push(eq(tariffs.categoryId, filter.categoryId));
    if (filter.regionId) conds.push(eq(tariffs.regionId, filter.regionId));
    if (filter.kind) conds.push(eq(tariffs.kind, filter.kind));
    const rows = await this.db
      .select({ t: tariffs, category: equipmentCategories.name, region: regions.name })
      .from(tariffs)
      .innerJoin(equipmentCategories, eq(equipmentCategories.id, tariffs.categoryId))
      .innerJoin(regions, eq(regions.id, tariffs.regionId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(equipmentCategories.name), asc(regions.name), asc(tariffs.kind), desc(tariffs.validFrom))
      .limit(2000);
    const now = Date.now();
    // Отмечаем, какая версия действует сейчас, а какие — запланированы или устарели.
    const current = new Set<string>();
    const seen = new Set<string>();
    for (const { t } of rows) {
      const k = `${t.categoryId}:${t.regionId}:${t.kind}`;
      if (!t.cancelledAt && t.validFrom.getTime() <= now && !seen.has(k)) {
        seen.add(k);
        current.add(t.id);
      }
    }
    return rows.map(({ t, category, region }) => ({
      id: t.id, categoryId: t.categoryId, category, regionId: t.regionId, region, kind: t.kind,
      priceKopecks: t.priceKopecks, validFrom: t.validFrom.toISOString(), reason: t.reason, createdBy: t.createdBy,
      createdAt: t.createdAt.toISOString(), cancelledAt: t.cancelledAt?.toISOString() ?? null,
      state: t.cancelledAt ? 'cancelled' : current.has(t.id) ? 'current' : t.validFrom.getTime() > now ? 'scheduled' : 'superseded',
    }));
  }

  /** Новая версия тарифа. Старые версии и уже оформленные заказы не меняются. */
  async createTariff(dto: CreateTariff, admin: AuthAdmin) {
    await this.catalog.getCategory(dto.categoryId);
    const [region] = await this.db.select().from(regions).where(eq(regions.id, dto.regionId));
    if (!region) throw notFound('Регион');
    const validFrom = dto.validFrom ? new Date(dto.validFrom) : new Date();
    if (validFrom.getTime() < Date.now() - 60_000) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Дата начала не может быть в прошлом', HttpStatus.BAD_REQUEST);
    }
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx.insert(tariffs).values({
          categoryId: dto.categoryId, regionId: dto.regionId, kind: dto.kind, priceKopecks: dto.priceKopecks,
          validFrom, reason: dto.reason ?? null, createdBy: admin.adminId,
        }).returning();
        await this.audit.log({ adminId: admin.adminId, action: 'tariff.create', entity: 'tariff', entityId: row?.id ?? null, after: row, reason: dto.reason ?? null, ip: admin.ip }, tx);
        return row;
      });
    } catch (e) {
      if (isUnique(e)) throw new AppException(ERROR_CODES.CONFLICT, 'Версия с такой датой начала уже есть', HttpStatus.CONFLICT);
      throw e;
    }
  }

  /** Отмена запланированной (ещё не действующей) версии. */
  async cancelTariff(id: string, admin: AuthAdmin) {
    const [t] = await this.db.select().from(tariffs).where(eq(tariffs.id, id));
    if (!t) throw notFound('Тариф');
    if (t.cancelledAt) throw new AppException(ERROR_CODES.CONFLICT, 'Тариф уже отменён', HttpStatus.CONFLICT);
    if (t.validFrom.getTime() <= Date.now()) {
      throw new AppException(ERROR_CODES.CONFLICT, 'Действующую версию нельзя отменить — создайте новую', HttpStatus.CONFLICT);
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx.update(tariffs).set({ cancelledAt: new Date(), cancelledBy: admin.adminId }).where(eq(tariffs.id, id)).returning();
      await this.audit.log({ adminId: admin.adminId, action: 'tariff.cancel', entity: 'tariff', entityId: id, before: t, ip: admin.ip }, tx);
      return row;
    });
  }

  // ── История ───────────────────────────────────────────────────────────────
  history(entity?: string, entityId?: string) {
    const entities = entity ? [entity] : ['category', 'attribute', 'tariff', 'measure_unit', 'region', 'equipment_unit'];
    const conds: SQL[] = [inArray(adminAuditLog.entity, entities)];
    if (entityId) conds.push(eq(adminAuditLog.entityId, entityId));
    return this.db.select().from(adminAuditLog).where(and(...conds)).orderBy(desc(adminAuditLog.id)).limit(500);
  }

  // ── Вспомогательное ───────────────────────────────────────────────────────
  private async hasUnits(categoryId: string): Promise<boolean> {
    const [u] = await this.db.select({ id: equipmentUnits.id }).from(equipmentUnits).where(eq(equipmentUnits.categoryId, categoryId)).limit(1);
    return Boolean(u);
  }

  private async getAttribute(id: string) {
    const [a] = await this.db.select().from(categoryAttributes).where(and(eq(categoryAttributes.id, id), isNull(categoryAttributes.archivedAt)));
    if (!a) throw notFound('Характеристика');
    return a;
  }

  private async unitId(code: string | null | undefined): Promise<string | null> {
    if (!code) return null;
    const [u] = await this.db.select({ id: measureUnits.id }).from(measureUnits).where(eq(measureUnits.code, code));
    if (!u) throw new AppException(ERROR_CODES.VALIDATION_FAILED, `Нет единицы измерения «${code}»`, HttpStatus.BAD_REQUEST);
    return u.id;
  }

  private assertTimezone(tz: string): void {
    try {
      new Intl.DateTimeFormat('ru-RU', { timeZone: tz });
    } catch {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Неизвестный часовой пояс', HttpStatus.BAD_REQUEST);
    }
  }

  private extractPolygons(g: Record<string, unknown>): unknown[] {
    const type = g['type'];
    if (type === 'Polygon' || type === 'MultiPolygon') return [g];
    if (type === 'Feature') return g['geometry'] ? this.extractPolygons(g['geometry'] as Record<string, unknown>) : [];
    if (type === 'FeatureCollection' && Array.isArray(g['features'])) {
      return (g['features'] as Record<string, unknown>[]).flatMap((f) => this.extractPolygons(f));
    }
    if (type === 'GeometryCollection' && Array.isArray(g['geometries'])) {
      return (g['geometries'] as Record<string, unknown>[]).flatMap((x) => this.extractPolygons(x));
    }
    return [];
  }
}
