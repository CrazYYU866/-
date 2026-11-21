import { boolean, inet, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull().unique(),
  fullName: text('full_name'),
  photoFileId: uuid('photo_file_id'),
  status: text('status', { enum: ['active', 'blocked'] }).notNull().default('active'),
  blockedReason: text('blocked_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const otpChallenges = pgTable('otp_challenges', {
  id: uuid('id').primaryKey().defaultRandom(),
  phone: text('phone').notNull(),
  app: text('app', { enum: ['client', 'partner'] }).notNull(),
  purpose: text('purpose', { enum: ['login', 'bank_account_change'] }).notNull().default('login'),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  ip: inet('ip'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authSessions = pgTable('auth_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  app: text('app', { enum: ['client', 'partner'] }).notNull(),
  familyId: uuid('family_id').notNull(),
  refreshTokenHash: text('refresh_token_hash').notNull().unique(),
  deviceId: text('device_id'),
  userAgent: text('user_agent'),
  ip: inet('ip'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokeReason: text('revoke_reason', {
    enum: ['rotated', 'logout', 'reuse_detected', 'user_blocked', 'admin'],
  }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
});

export const pushDevices = pgTable('push_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  app: text('app', { enum: ['client', 'partner'] }).notNull(),
  platform: text('platform', { enum: ['ios', 'android'] }).notNull(),
  token: text('token').notNull().unique(),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
