import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, type AttributeValues, type TariffKind } from '@kovsh/contracts';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import { DB, type Database } from '../database/database.module';
import { categoryAttributes, equipmentCategories, measureUnits, regions } from '../database/schema';

export type CategoryRow = typeof equipmentCategories.$inferSelect;
export type Audience = 'customer' | 'partner' | 'admin';

export interface AttributeView {
  id: string;
  categoryId: string;
  key: string;
  label: string;
  type: string;
  unit: { code: string; label: string } | null;
  options: string[] | null;
  required: boolean;
  filterable: boolean;
  minValue: number | null;
  maxValue: number | null;
  sort: number;
  inherited: boolean;
}

export interface CategoryNode {
  id: string;
  parentId: string | null;
  slug: string;
  name: string;
  description: string | null;
  imageFileId: string | null;
  yearRequired: boolean;
  visibleToCustomers: boolean;
  visibleToPartners: boolean;
  archived: boolean;
  sort: number;
  isLeaf: boolean;
  attributes: AttributeView[];
  /** Текущая цена аренды за час в выбранном регионе (если запрошен регион). */
  hourPriceKopecks?: number | null;
  children: CategoryNode[];
}

export interface EffectiveTariff {
  tariffId: string;
  categoryId: string;
  priceKopecks: number;
  validFrom: Date;
}

/** Единый каталог для приложений и админки: категории, наследуемые характеристики, действующие тарифы. */
@Injectable()
export class CatalogService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async tree(audience: Audience, regionId?: string): Promise<CategoryNode[]> {
    const [cats, attrs] = await Promise.all([
      this.db.select().from(equipmentCategories).orderBy(asc(equipmentCategories.sort), asc(equipmentCategories.name)),
      this.attributeRows(),
    ]);
    const visible = (c: CategoryRow) =>
      audience === 'admin' ||
      (c.archivedAt === null && (audience === 'customer' ? c.visibleToCustomers : c.visibleToPartners));

    const byParent = new Map<string | null, CategoryRow[]>();
    for (const c of cats) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);

    const prices = regionId ? await this.currentPrices(regionId, 'rent_hour') : null;

    const build = (c: CategoryRow, inheritedAttrs: AttributeView[], inheritedPrice: number | null): CategoryNode | null => {
      if (!visible(c)) return null;
      const own = attrs.filter((a) => a.categoryId === c.id).map((a) => ({ ...a, inherited: false }));
      const allAttrs = [...inheritedAttrs.map((a) => ({ ...a, inherited: true })), ...own];
      const price = prices ? (prices.get(c.id) ?? inheritedPrice) : null;
      const children = (byParent.get(c.id) ?? [])
        .map((ch) => build(ch, allAttrs, price))
        .filter((x): x is CategoryNode => x !== null);
      const hasAnyChildren = (byParent.get(c.id) ?? []).some((ch) => ch.archivedAt === null);
      const node: CategoryNode = {
        id: c.id, parentId: c.parentId, slug: c.slug, name: c.name, description: c.description,
        imageFileId: c.imageFileId, yearRequired: c.yearRequired, visibleToCustomers: c.visibleToCustomers,
        visibleToPartners: c.visibleToPartners, archived: c.archivedAt !== null, sort: c.sort,
        isLeaf: !hasAnyChildren, attributes: allAttrs, children,
      };
      if (prices) node.hourPriceKopecks = price;
      // Пустые группы не показываем в приложениях.
      if (audience !== 'admin' && !node.isLeaf && children.length === 0) return null;
      return node;
    };
    return (byParent.get(null) ?? []).map((c) => build(c, [], null)).filter((x): x is CategoryNode => x !== null);
  }

  async getCategory(id: string): Promise<CategoryRow> {
    const [c] = await this.db.select().from(equipmentCategories).where(eq(equipmentCategories.id, id));
    if (!c) throw new AppException(ERROR_CODES.NOT_FOUND, 'Категория не найдена', HttpStatus.NOT_FOUND);
    return c;
  }

  /** Цепочка от категории к корню (сама категория первая). */
  async ancestors(id: string): Promise<CategoryRow[]> {
    const res = await this.db.execute<{ id: string; depth: number }>(sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, 0 AS depth FROM equipment_categories WHERE id = ${id}
        UNION ALL
        SELECT c.id, c.parent_id, chain.depth + 1 FROM equipment_categories c JOIN chain ON c.id = chain.parent_id
      ) SELECT id, depth FROM chain ORDER BY depth`);
    const ids = res.rows.map((r) => r.id);
    if (ids.length === 0) throw new AppException(ERROR_CODES.NOT_FOUND, 'Категория не найдена', HttpStatus.NOT_FOUND);
    const rows = await this.db.select().from(equipmentCategories).where(inArray(equipmentCategories.id, ids));
    return ids.map((i) => rows.find((r) => r.id === i)).filter((r): r is CategoryRow => r !== undefined);
  }

  async isLeaf(id: string): Promise<boolean> {
    const [child] = await this.db
      .select({ id: equipmentCategories.id })
      .from(equipmentCategories)
      .where(and(eq(equipmentCategories.parentId, id), isNull(equipmentCategories.archivedAt)))
      .limit(1);
    return !child;
  }

  /** Категория, в которую можно добавить технику: конечная, не в архиве, доступна партнёрам. */
  async assertUnitCategory(id: string): Promise<CategoryRow> {
    const chain = await this.ancestors(id);
    const cat = chain[0];
    if (!cat || chain.some((c) => c.archivedAt !== null || !c.visibleToPartners)) {
      throw new AppException(ERROR_CODES.NOT_FOUND, 'Категория недоступна', HttpStatus.NOT_FOUND);
    }
    if (!(await this.isLeaf(id))) {
      throw new AppException(ERROR_CODES.CATEGORY_NOT_LEAF, 'Выберите конкретный вид техники', HttpStatus.BAD_REQUEST);
    }
    return cat;
  }

  /** Характеристики категории с учётом наследования от родителей. */
  async effectiveAttributes(categoryId: string): Promise<AttributeView[]> {
    const chain = (await this.ancestors(categoryId)).map((c) => c.id);
    const rows = await this.attributeRows();
    return chain
      .slice()
      .reverse()
      .flatMap((cid) => rows.filter((a) => a.categoryId === cid).map((a) => ({ ...a, inherited: cid !== categoryId })));
  }

  /** Проверяет и нормализует значения характеристик. Возвращает очищенный объект. */
  async validateAttributes(categoryId: string, values: AttributeValues): Promise<Record<string, unknown>> {
    const defs = await this.effectiveAttributes(categoryId);
    const errors: { key: string; message: string }[] = [];
    const out: Record<string, unknown> = {};
    const known = new Set(defs.map((d) => d.key));
    for (const key of Object.keys(values)) if (!known.has(key)) errors.push({ key, message: 'неизвестная характеристика' });

    for (const d of defs) {
      const v = values[d.key];
      if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
        if (d.required) errors.push({ key: d.key, message: `обязательная характеристика «${d.label}»` });
        continue;
      }
      switch (d.type) {
        case 'number':
        case 'integer': {
          if (typeof v !== 'number' || !Number.isFinite(v) || (d.type === 'integer' && !Number.isInteger(v))) {
            errors.push({ key: d.key, message: d.type === 'integer' ? 'нужно целое число' : 'нужно число' });
            break;
          }
          if (d.minValue !== null && v < d.minValue) errors.push({ key: d.key, message: `не меньше ${d.minValue}` });
          else if (d.maxValue !== null && v > d.maxValue) errors.push({ key: d.key, message: `не больше ${d.maxValue}` });
          else if (v < 0) errors.push({ key: d.key, message: 'не может быть отрицательным' });
          else out[d.key] = v;
          break;
        }
        case 'boolean':
          if (typeof v !== 'boolean') errors.push({ key: d.key, message: 'нужно да/нет' });
          else out[d.key] = v;
          break;
        case 'text':
          if (typeof v !== 'string' || v.length > 500) errors.push({ key: d.key, message: 'нужен текст до 500 символов' });
          else out[d.key] = v.trim();
          break;
        case 'enum':
          if (typeof v !== 'string' || !d.options?.includes(v)) errors.push({ key: d.key, message: 'значение не из списка' });
          else out[d.key] = v;
          break;
        case 'multi_enum':
          if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && d.options?.includes(x))) {
            errors.push({ key: d.key, message: 'значения не из списка' });
          } else out[d.key] = [...new Set(v)];
          break;
      }
    }
    if (errors.length > 0) {
      throw new AppException(ERROR_CODES.INVALID_ATTRIBUTES, 'Проверьте характеристики техники', HttpStatus.BAD_REQUEST, errors);
    }
    return out;
  }

  /**
   * Действующий тариф: ищется сначала у самой категории, затем у родителей (подкатегория приоритетнее).
   * Версия — последняя неотменённая с датой начала не позже момента `at`.
   */
  async effectiveTariff(categoryId: string, regionId: string, kind: TariffKind, at: Date = new Date()): Promise<EffectiveTariff | null> {
    const res = await this.db.execute<{ id: string; category_id: string; price_kopecks: string; valid_from: Date }>(sql`
      WITH RECURSIVE chain AS (
        SELECT id, parent_id, 0 AS depth FROM equipment_categories WHERE id = ${categoryId}
        UNION ALL
        SELECT c.id, c.parent_id, chain.depth + 1 FROM equipment_categories c JOIN chain ON c.id = chain.parent_id
      )
      SELECT t.id, t.category_id, t.price_kopecks, t.valid_from
      FROM chain JOIN tariffs t ON t.category_id = chain.id
      WHERE t.region_id = ${regionId} AND t.kind = ${kind} AND t.cancelled_at IS NULL AND t.valid_from <= ${at.toISOString()}
      ORDER BY chain.depth ASC, t.valid_from DESC
      LIMIT 1`);
    const r = res.rows[0];
    return r ? { tariffId: r.id, categoryId: r.category_id, priceKopecks: Number(r.price_kopecks), validFrom: new Date(r.valid_from) } : null;
  }

  /** Регион по координатам объекта — по границам зон обслуживания (К-15). */
  async regionByPoint(lat: number, lng: number): Promise<typeof regions.$inferSelect | null> {
    const res = await this.db.execute<{ id: string }>(sql`
      SELECT r.id FROM service_zones z JOIN regions r ON r.id = z.region_id
      WHERE z.active AND r.active AND ST_Covers(z.area, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography)
      ORDER BY r.sort LIMIT 1`);
    const id = res.rows[0]?.id;
    if (!id) return null;
    const [row] = await this.db.select().from(regions).where(eq(regions.id, id));
    return row ?? null;
  }

  async listRegions(onlyActive: boolean) {
    const rows = await this.db.select().from(regions).orderBy(asc(regions.sort));
    const zones = await this.db.execute<{ region_id: string; zones: number }>(
      sql`SELECT region_id, count(*)::int AS zones FROM service_zones WHERE active GROUP BY region_id`,
    );
    return rows
      .filter((r) => !onlyActive || r.active)
      .map((r) => ({ ...r, zonesCount: zones.rows.find((z) => z.region_id === r.id)?.zones ?? 0 }));
  }

  private async currentPrices(regionId: string, kind: TariffKind): Promise<Map<string, number>> {
    const res = await this.db.execute<{ category_id: string; price_kopecks: string }>(sql`
      SELECT DISTINCT ON (category_id) category_id, price_kopecks FROM tariffs
      WHERE region_id = ${regionId} AND kind = ${kind} AND cancelled_at IS NULL AND valid_from <= now()
      ORDER BY category_id, valid_from DESC`);
    return new Map(res.rows.map((r) => [r.category_id, Number(r.price_kopecks)]));
  }

  private async attributeRows(): Promise<Omit<AttributeView, 'inherited'>[]> {
    const rows = await this.db
      .select({ a: categoryAttributes, u: measureUnits })
      .from(categoryAttributes)
      .leftJoin(measureUnits, eq(measureUnits.id, categoryAttributes.unitId))
      .where(isNull(categoryAttributes.archivedAt))
      .orderBy(asc(categoryAttributes.sort));
    return rows.map(({ a, u }) => ({
      id: a.id, categoryId: a.categoryId, key: a.key, label: a.label, type: a.type,
      unit: u ? { code: u.code, label: u.label } : null, options: a.options ?? null, required: a.required,
      filterable: a.filterable, minValue: a.minValue, maxValue: a.maxValue, sort: a.sort,
    }));
  }
}
