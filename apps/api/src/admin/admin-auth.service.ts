import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ERROR_CODES, type AdminRole } from '@kovsh/contracts';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { authenticator } from 'otplib';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/app-exception';
import { FieldCipher } from '../common/crypto/field-cipher';
import { hashPassword, verifyPassword } from '../common/crypto/password';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { DB, type Database } from '../database/database.module';
import { adminSessions, adminUsers } from '../database/schema';

export const ADMIN_JWT = Symbol('ADMIN_JWT');

const ACCESS_TTL_SEC = 900;
const REFRESH_TTL_MS = 12 * 3600 * 1000; // рабочая смена администратора
const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

export interface AdminTokenPayload {
  sub: string;
  sid: string;
  role: AdminRole;
  typ: 'admin';
  /** Включена ли 2FA. Пока нет — доступны только подключение 2FA, профиль и выход (С-9). */
  totpEnabled?: boolean;
}

export interface AdminTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  admin: { id: string; email: string; fullName: string; role: AdminRole; totpEnabled: boolean };
  /** Нужно подключить двухфакторную авторизацию, прежде чем работать (С-9). */
  mustEnrollTotp: boolean;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

@Injectable()
export class AdminAuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ADMIN_JWT) private readonly jwt: JwtService,
    private readonly cipher: FieldCipher,
    private readonly audit: AuditService,
  ) {}

  async createAdmin(input: { email: string; fullName: string; role: AdminRole; password: string }, createdBy: string | null) {
    const [row] = await this.db
      .insert(adminUsers)
      .values({
        email: input.email.toLowerCase(),
        fullName: input.fullName,
        role: input.role,
        passwordHash: await hashPassword(input.password),
        createdBy,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new AppException(ERROR_CODES.CONFLICT, 'Администратор с таким email уже есть', HttpStatus.CONFLICT);
    await this.audit.log({ adminId: createdBy, action: 'admin.create', entity: 'admin_user', entityId: row.id, after: { email: row.email, role: row.role } });
    return row;
  }

  async login(email: string, password: string, totpCode: string | undefined, ip: string | null, userAgent?: string): Promise<AdminTokens> {
    const [admin] = await this.db.select().from(adminUsers).where(eq(adminUsers.email, email.toLowerCase()));
    const invalid = () => new AppException(ERROR_CODES.INVALID_CREDENTIALS, 'Неверный email или пароль', HttpStatus.UNAUTHORIZED);
    if (!admin || admin.status !== 'active') throw invalid();
    if (admin.lockedUntil && admin.lockedUntil.getTime() > Date.now()) {
      throw new AppException(ERROR_CODES.RATE_LIMITED, 'Вход временно заблокирован после неудачных попыток', HttpStatus.TOO_MANY_REQUESTS);
    }
    if (!(await verifyPassword(password, admin.passwordHash))) {
      await this.db
        .update(adminUsers)
        .set({
          failedLogins: sql`${adminUsers.failedLogins} + 1`,
          lockedUntil: sql`CASE WHEN ${adminUsers.failedLogins} + 1 >= ${MAX_FAILED} THEN now() + interval '${sql.raw(String(LOCK_MS / 1000))} seconds' ELSE NULL END`,
        })
        .where(eq(adminUsers.id, admin.id));
      throw invalid();
    }
    if (admin.totpEnabled) {
      if (!totpCode) throw new AppException(ERROR_CODES.TOTP_REQUIRED, 'Введите код из приложения-аутентификатора', HttpStatus.UNAUTHORIZED);
      if (!admin.totpSecretEnc || !authenticator.check(totpCode, this.cipher.decrypt(admin.totpSecretEnc))) throw invalid();
    }
    await this.db.update(adminUsers).set({ failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(adminUsers.id, admin.id));
    await this.audit.log({ adminId: admin.id, action: 'admin.login', entity: 'admin_user', entityId: admin.id, ip });
    return this.issue(admin, randomUUID(), ip, userAgent);
  }

  async refresh(refreshToken: string, ip: string | null): Promise<AdminTokens> {
    return this.db.transaction(async (tx) => {
      const [s] = await tx.select().from(adminSessions).where(eq(adminSessions.refreshTokenHash, sha(refreshToken))).for('update');
      const fail = () => new AppException(ERROR_CODES.REFRESH_INVALID, 'Сессия недействительна, войдите заново', HttpStatus.UNAUTHORIZED);
      if (!s) throw fail();
      if (s.revokedAt) {
        if (s.revokeReason === 'rotated') {
          await tx.update(adminSessions).set({ revokedAt: new Date(), revokeReason: 'reuse_detected' })
            .where(and(eq(adminSessions.familyId, s.familyId), isNull(adminSessions.revokedAt)));
        }
        throw fail();
      }
      if (s.expiresAt.getTime() <= Date.now()) throw fail();
      const [admin] = await tx.select().from(adminUsers).where(eq(adminUsers.id, s.adminId));
      if (!admin || admin.status !== 'active') throw fail();
      await tx.update(adminSessions).set({ revokedAt: new Date(), revokeReason: 'rotated' }).where(eq(adminSessions.id, s.id));
      return this.issue(admin, s.familyId, ip, undefined, tx);
    });
  }

  async logout(sessionId: string): Promise<void> {
    await this.db.update(adminSessions).set({ revokedAt: new Date(), revokeReason: 'logout' })
      .where(and(eq(adminSessions.id, sessionId), isNull(adminSessions.revokedAt)));
  }

  async verifyAccess(token: string): Promise<AdminTokenPayload | null> {
    let payload: AdminTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AdminTokenPayload>(token);
    } catch {
      return null;
    }
    if (payload.typ !== 'admin') return null;
    const [row] = await this.db
      .select({ role: adminUsers.role, status: adminUsers.status, totpEnabled: adminUsers.totpEnabled, revokedAt: adminSessions.revokedAt, expiresAt: adminSessions.expiresAt })
      .from(adminSessions)
      .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.adminId))
      .where(and(eq(adminSessions.id, payload.sid), eq(adminSessions.adminId, payload.sub)));
    if (!row || row.status !== 'active' || row.revokedAt || row.expiresAt.getTime() <= Date.now()) return null;
    // Роль берётся из БД: смена роли действует сразу, без перевыпуска токена.
    return { ...payload, role: row.role, totpEnabled: row.totpEnabled };
  }

  async setupTotp(adminId: string): Promise<{ otpauthUrl: string; secret: string }> {
    const [admin] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, adminId));
    if (!admin) throw new AppException(ERROR_CODES.NOT_FOUND, 'Не найден', HttpStatus.NOT_FOUND);
    if (admin.totpEnabled) throw new AppException(ERROR_CODES.CONFLICT, '2FA уже включена', HttpStatus.CONFLICT);
    const secret = authenticator.generateSecret();
    await this.db.update(adminUsers).set({ totpSecretEnc: this.cipher.encrypt(secret) }).where(eq(adminUsers.id, adminId));
    return { secret, otpauthUrl: authenticator.keyuri(admin.email, 'Ковш на Час — админ', secret) };
  }

  async confirmTotp(adminId: string, code: string): Promise<void> {
    const [admin] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, adminId));
    if (!admin?.totpSecretEnc || !authenticator.check(code, this.cipher.decrypt(admin.totpSecretEnc))) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Неверный код', HttpStatus.BAD_REQUEST);
    }
    await this.db.update(adminUsers).set({ totpEnabled: true }).where(eq(adminUsers.id, adminId));
    await this.audit.log({ adminId, action: 'admin.totp_enabled', entity: 'admin_user', entityId: adminId });
  }

  private async issue(
    admin: typeof adminUsers.$inferSelect,
    familyId: string,
    ip: string | null,
    userAgent: string | undefined,
    db: Pick<Database, 'insert'> = this.db,
  ): Promise<AdminTokens> {
    const refreshToken = randomBytes(32).toString('base64url');
    const [s] = await db
      .insert(adminSessions)
      .values({ adminId: admin.id, familyId, refreshTokenHash: sha(refreshToken), ip, userAgent: userAgent?.slice(0, 500) ?? null, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) })
      .returning({ id: adminSessions.id });
    if (!s) throw new Error('Не удалось создать сессию');
    const payload: AdminTokenPayload = { sub: admin.id, sid: s.id, role: admin.role, typ: 'admin' };
    return {
      accessToken: await this.jwt.signAsync(payload, { expiresIn: ACCESS_TTL_SEC }),
      refreshToken,
      accessTokenExpiresIn: ACCESS_TTL_SEC,
      admin: { id: admin.id, email: admin.email, fullName: admin.fullName, role: admin.role, totpEnabled: admin.totpEnabled },
      mustEnrollTotp: !admin.totpEnabled,
    };
  }
}
