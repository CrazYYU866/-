import { z } from 'zod';

export const ATTRIBUTE_TYPES = ['number', 'integer', 'boolean', 'text', 'enum', 'multi_enum'] as const;
export type AttributeType = (typeof ATTRIBUTE_TYPES)[number];
export const TARIFF_KINDS = ['rent_hour', 'delivery_km'] as const;
export type TariffKind = (typeof TARIFF_KINDS)[number];
export const UNIT_VERIFICATION_STATUSES = ['draft', 'pending', 'approved', 'rejected'] as const;
export type UnitVerificationStatus = (typeof UNIT_VERIFICATION_STATUSES)[number];

const slug = z.string().regex(/^[a-z][a-z0-9_]{1,62}$/, 'латиница в нижнем регистре, цифры и _');

// ── Админка: категории ─────────────────────────────────────────────────────
export const CreateCategorySchema = z.object({
  parentId: z.string().uuid().nullable().optional(),
  slug,
  name: z.string().trim().min(2).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  imageFileId: z.string().uuid().nullable().optional(),
  yearRequired: z.boolean().default(true),
  visibleToCustomers: z.boolean().default(true),
  visibleToPartners: z.boolean().default(true),
  sort: z.number().int().default(0),
});
export type CreateCategory = z.infer<typeof CreateCategorySchema>;
export const UpdateCategorySchema = z.object({
  parentId: z.string().uuid().nullable().optional(),
  name: z.string().trim().min(2).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  imageFileId: z.string().uuid().nullable().optional(),
  yearRequired: z.boolean().optional(),
  visibleToCustomers: z.boolean().optional(),
  visibleToPartners: z.boolean().optional(),
  sort: z.number().int().optional(),
});
export type UpdateCategory = z.infer<typeof UpdateCategorySchema>;

// ── Админка: характеристики ────────────────────────────────────────────────
const AttributeBase = z.object({
  key: slug,
  label: z.string().trim().min(1).max(200),
  type: z.enum(ATTRIBUTE_TYPES),
  unitCode: z.string().max(20).nullable().optional(),
  options: z.array(z.string().trim().min(1).max(100)).min(1).max(100).nullable().optional(),
  required: z.boolean().default(false),
  filterable: z.boolean().default(false),
  minValue: z.number().nullable().optional(),
  maxValue: z.number().nullable().optional(),
  sort: z.number().int().default(0),
});
const enumNeedsOptions = (a: { type?: AttributeType; options?: string[] | null | undefined }) =>
  a.type === undefined || (a.type === 'enum' || a.type === 'multi_enum') === Boolean(a.options && a.options.length);
export const CreateAttributeSchema = AttributeBase.refine(enumNeedsOptions, {
  message: 'варианты задаются только для списков и обязательны для них',
  path: ['options'],
});
export type CreateAttribute = z.infer<typeof CreateAttributeSchema>;
export const UpdateAttributeSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  unitCode: z.string().max(20).nullable().optional(),
  options: z.array(z.string().trim().min(1).max(100)).min(1).max(100).nullable().optional(),
  required: z.boolean().optional(),
  filterable: z.boolean().optional(),
  minValue: z.number().nullable().optional(),
  maxValue: z.number().nullable().optional(),
  sort: z.number().int().optional(),
});
export type UpdateAttribute = z.infer<typeof UpdateAttributeSchema>;

export const MeasureUnitSchema = z.object({
  code: z.string().regex(/^[a-z0-9_]{1,20}$/),
  label: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(100),
});
export type MeasureUnitInput = z.infer<typeof MeasureUnitSchema>;

// ── Админка: регионы и тарифы ──────────────────────────────────────────────
export const CreateRegionSchema = z.object({
  code: slug,
  name: z.string().trim().min(2).max(200),
  timezone: z.string().min(3).max(64),
  active: z.boolean().default(true),
  sort: z.number().int().default(0),
});
export type CreateRegion = z.infer<typeof CreateRegionSchema>;
export const UpdateRegionSchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  timezone: z.string().min(3).max(64).optional(),
  active: z.boolean().optional(),
  sort: z.number().int().optional(),
});

export const ImportZoneSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /** GeoJSON: Polygon, MultiPolygon, Feature или FeatureCollection. */
  geojson: z.record(z.string(), z.unknown()),
});
export type ImportZone = z.infer<typeof ImportZoneSchema>;

export const CreateTariffSchema = z.object({
  categoryId: z.string().uuid(),
  regionId: z.string().uuid(),
  kind: z.enum(TARIFF_KINDS),
  priceKopecks: z.number().int().positive().max(100_000_000),
  /** Дата начала действия. Не указана — с текущего момента. */
  validFrom: z.string().datetime({ offset: true }).optional(),
  reason: z.string().trim().max(2000).optional(),
});
export type CreateTariff = z.infer<typeof CreateTariffSchema>;

// ── Партнёр: техника ───────────────────────────────────────────────────────
export const AttributeValuesSchema = z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.array(z.string())]));
export type AttributeValues = z.infer<typeof AttributeValuesSchema>;

export const GeoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPointSchema>;

export const CreateUnitSchema = z.object({
  categoryId: z.string().uuid(),
  brand: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(100),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  regNumber: z.string().trim().min(4).max(20).nullable().optional(),
  attributes: AttributeValuesSchema.default({}),
  base: GeoPointSchema.extend({ address: z.string().trim().min(5).max(500) }),
  workRadiusKm: z.number().int().min(1).max(1000),
  allowBeyondRadius: z.boolean().default(false),
});
export type CreateUnit = z.infer<typeof CreateUnitSchema>;
/** Частичное обновление: без значений по умолчанию, иначе незатронутые поля сбрасывались бы. */
export const UpdateUnitSchema = z.object({
  categoryId: z.string().uuid().optional(),
  brand: z.string().trim().min(1).max(100).optional(),
  model: z.string().trim().min(1).max(100).optional(),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  regNumber: z.string().trim().min(4).max(20).nullable().optional(),
  attributes: AttributeValuesSchema.optional(),
  base: GeoPointSchema.extend({ address: z.string().trim().min(5).max(500) }).optional(),
  workRadiusKm: z.number().int().min(1).max(1000).optional(),
  allowBeyondRadius: z.boolean().optional(),
});
export type UpdateUnit = z.infer<typeof UpdateUnitSchema>;

export const ScheduleSchema = z.object({
  intervals: z
    .array(
      z.object({
        weekday: z.number().int().min(1).max(7),
        start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/),
      }),
    )
    .max(50),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export const AddPhotoSchema = z.object({ fileId: z.string().uuid() });
