import { bigint, boolean, customType, integer, jsonb, numeric, pgTable, text, time, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Геоданные PostGIS. Читаются и пишутся через SQL-функции (ST_*), в TS — как непрозрачная строка. */
export const geography = customType<{ data: string; driverData: string }>({
  dataType: () => 'geography',
});
const tstzrange = customType<{ data: string; driverData: string }>({ dataType: () => 'tstzrange' });

export const regions = pgTable('regions', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull(),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const serviceZones = pgTable('service_zones', {
  id: uuid('id').primaryKey().defaultRandom(),
  regionId: uuid('region_id').notNull(),
  name: text('name').notNull(),
  area: geography('area').notNull(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const measureUnits = pgTable('measure_units', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  label: text('label').notNull(),
  name: text('name').notNull(),
});

export const equipmentCategories = pgTable('equipment_categories', {
  id: uuid('id').primaryKey().defaultRandom(),
  parentId: uuid('parent_id'),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  imageFileId: uuid('image_file_id'),
  yearRequired: boolean('year_required').notNull().default(true),
  visibleToCustomers: boolean('visible_to_customers').notNull().default(true),
  visibleToPartners: boolean('visible_to_partners').notNull().default(true),
  sort: integer('sort').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const categoryAttributes = pgTable('category_attributes', {
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id').notNull(),
  key: text('key').notNull(),
  label: text('label').notNull(),
  type: text('type', { enum: ['number', 'integer', 'boolean', 'text', 'enum', 'multi_enum'] }).notNull(),
  unitId: uuid('unit_id'),
  options: jsonb('options').$type<string[] | null>(),
  required: boolean('required').notNull().default(false),
  filterable: boolean('filterable').notNull().default(false),
  minValue: numeric('min_value', { mode: 'number' }),
  maxValue: numeric('max_value', { mode: 'number' }),
  sort: integer('sort').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tariffs = pgTable('tariffs', {
  id: uuid('id').primaryKey().defaultRandom(),
  categoryId: uuid('category_id').notNull(),
  regionId: uuid('region_id').notNull(),
  kind: text('kind', { enum: ['rent_hour', 'delivery_km'] }).notNull(),
  priceKopecks: bigint('price_kopecks', { mode: 'number' }).notNull(),
  validFrom: timestamp('valid_from', { withTimezone: true }).notNull().defaultNow(),
  reason: text('reason'),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  cancelledBy: uuid('cancelled_by'),
});

export const equipmentUnits = pgTable('equipment_units', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  categoryId: uuid('category_id').notNull(),
  brand: text('brand').notNull(),
  model: text('model').notNull(),
  year: integer('year'),
  regNumber: text('reg_number'),
  attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
  basePoint: geography('base_point').notNull(),
  baseAddress: text('base_address').notNull(),
  workRadiusKm: integer('work_radius_km').notNull(),
  allowBeyondRadius: boolean('allow_beyond_radius').notNull().default(false),
  isOnline: boolean('is_online').notNull().default(false),
  verificationStatus: text('verification_status', { enum: ['draft', 'pending', 'approved', 'rejected'] }).notNull().default('draft'),
  rejectionReason: text('rejection_reason'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const equipmentUnitStatusHistory = pgTable('equipment_unit_status_history', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  unitId: uuid('unit_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  reason: text('reason'),
  actorUserId: uuid('actor_user_id'),
  actorAdminId: uuid('actor_admin_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const equipmentPhotos = pgTable('equipment_photos', {
  id: uuid('id').primaryKey().defaultRandom(),
  unitId: uuid('unit_id').notNull(),
  fileId: uuid('file_id').notNull(),
  sort: integer('sort').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const equipmentSchedules = pgTable('equipment_schedules', {
  id: uuid('id').primaryKey().defaultRandom(),
  unitId: uuid('unit_id').notNull(),
  weekday: integer('weekday').notNull(),
  startTime: time('start_time').notNull(),
  endTime: time('end_time').notNull(),
});

export const unitBookings = pgTable('unit_bookings', {
  id: uuid('id').primaryKey().defaultRandom(),
  unitId: uuid('unit_id').notNull(),
  period: tstzrange('period').notNull(),
  orderId: uuid('order_id'),
  status: text('status', { enum: ['active', 'released'] }).notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
