import { bigint, boolean, date, inet, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users';

export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role', { enum: ['superadmin', 'support', 'finance', 'moderator'] }).notNull(),
  status: text('status', { enum: ['active', 'disabled'] }).notNull().default('active'),
  totpSecretEnc: text('totp_secret_enc'),
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  createdBy: uuid('created_by'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const adminSessions = pgTable('admin_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  adminId: uuid('admin_id').notNull().references(() => adminUsers.id, { onDelete: 'cascade' }),
  familyId: uuid('family_id').notNull(),
  refreshTokenHash: text('refresh_token_hash').notNull().unique(),
  ip: inet('ip'),
  userAgent: text('user_agent'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokeReason: text('revoke_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const adminAuditLog = pgTable('admin_audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  adminId: uuid('admin_id'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  before: jsonb('before'),
  after: jsonb('after'),
  reason: text('reason'),
  ip: inet('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const files = pgTable('files', {
  id: uuid('id').primaryKey().defaultRandom(),
  storageKey: text('storage_key').notNull().unique(),
  mime: text('mime').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  originalName: text('original_name'),
  uploadedByUserId: uuid('uploaded_by_user_id'),
  uploadedByAdminId: uuid('uploaded_by_admin_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind', { enum: ['partner', 'agent'] }).notNull(),
  legalForm: text('legal_form', { enum: ['ip', 'llc', 'jsc', 'other_legal_entity'] }).notNull(),
  name: text('name').notNull(),
  representativeName: text('representative_name').notNull(),
  inn: text('inn').notNull(),
  ogrn: text('ogrn').notNull(),
  kpp: text('kpp'),
  legalAddress: text('legal_address').notNull(),
  email: text('email').notNull(),
  contactPhone: text('contact_phone').notNull(),
  status: text('status', { enum: ['draft', 'pending_review', 'verified', 'rejected', 'blocked'] })
    .notNull()
    .default('draft'),
  rejectionReason: text('rejection_reason'),
  blockedReason: text('blocked_reason'),
  registryCheck: jsonb('registry_check'),
  verifiedAt: timestamp('verified_at', { withTimezone: true }),
  submittedAt: timestamp('submitted_at', { withTimezone: true }),
  createdBy: uuid('created_by').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizationStatusHistory = pgTable('organization_status_history', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: uuid('org_id').notNull(),
  fromStatus: text('from_status'),
  toStatus: text('to_status').notNull(),
  reason: text('reason'),
  actorUserId: uuid('actor_user_id'),
  actorAdminId: uuid('actor_admin_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizationBankAccounts = pgTable('organization_bank_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull(),
  bik: text('bik').notNull(),
  accountNumberEnc: text('account_number_enc').notNull(),
  accountNumberLast4: text('account_number_last4').notNull(),
  correspondentAccount: text('correspondent_account').notNull(),
  bankName: text('bank_name').notNull(),
  isCurrent: boolean('is_current').notNull().default(true),
  createdBy: uuid('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizationMembers = pgTable('organization_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id),
  role: text('role', { enum: ['owner', 'manager', 'dispatcher', 'operator'] }).notNull(),
  canOperate: boolean('can_operate').notNull().default(false),
  status: text('status', { enum: ['invited', 'active', 'blocked', 'detached'] }).notNull(),
  invitedBy: uuid('invited_by'),
  joinedAt: timestamp('joined_at', { withTimezone: true }),
  detachedAt: timestamp('detached_at', { withTimezone: true }),
  detachedBy: uuid('detached_by'),
  operatorVerification: text('operator_verification', {
    enum: ['not_submitted', 'pending', 'approved', 'rejected'],
  })
    .notNull()
    .default('not_submitted'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const organizationOwnershipHistory = pgTable('organization_ownership_history', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  orgId: uuid('org_id').notNull(),
  fromUserId: uuid('from_user_id').notNull(),
  toUserId: uuid('to_user_id').notNull(),
  adminId: uuid('admin_id').notNull(),
  basisFileIds: uuid('basis_file_ids').array().notNull(),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documentTypes = pgTable('document_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: text('code').notNull().unique(),
  title: text('title').notNull(),
  appliesTo: text('applies_to', { enum: ['organization', 'equipment', 'operator'] }).notNull(),
  legalForms: text('legal_forms').array(),
  required: boolean('required').notNull().default(true),
  hasExpiry: boolean('has_expiry').notNull().default(false),
  active: boolean('active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
});

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerType: text('owner_type', { enum: ['organization', 'equipment', 'operator'] }).notNull(),
  ownerId: uuid('owner_id').notNull(),
  documentTypeId: uuid('document_type_id').notNull(),
  fileId: uuid('file_id').notNull(),
  status: text('status', { enum: ['uploaded', 'approved', 'rejected', 'expired'] }).notNull().default('uploaded'),
  uploadedBy: uuid('uploaded_by'),
  reviewerAdminId: uuid('reviewer_admin_id'),
  reviewComment: text('review_comment'),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  expiresAt: date('expires_at'),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const userActionLog = pgTable('user_action_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  userId: uuid('user_id'),
  orgId: uuid('org_id'),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: text('entity_id'),
  details: jsonb('details'),
  ip: inet('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
