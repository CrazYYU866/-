import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ERROR_CODES, type ClientApp } from '@kovsh/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppException } from '../common/app-exception';
import { DB, type Database } from '../database/database.module';
import { authSessions, users } from '../database/schema';
import { SettingsService } from '../settings/settings.service';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  app: ClientApp;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  sessionId: string;
}

export interface SessionMeta {
  deviceId?: string | undefined;
  userAgent?: string | undefined;
  ip: string | null;
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

@Injectable()
export class SessionService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly jwt: JwtService,
    private readonly settings: SettingsService,
  ) {}

  async create(userId: string, app: ClientApp, meta: SessionMeta, familyId: string = randomUUID()): Promise<IssuedTokens> {
    return this.insertSession(this.db, userId, app, meta, familyId);
  }

  /**
   * Ротация refresh-токена. Старый токен погашается; повторное его предъявление
   * считается кражей и отзывает все сессии этой семьи.
   */
  async refresh(refreshToken: string, meta: SessionMeta): Promise<IssuedTokens> {
    const tokenHash = hashToken(refreshToken);
    const outcome = await this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(authSessions)
        .where(eq(authSessions.refreshTokenHash, tokenHash))
        .for('update');
      if (!session) return { error: ERROR_CODES.REFRESH_INVALID, tokens: undefined } as const;

      if (session.revokedAt !== null) {
        if (session.revokeReason === 'rotated') {
          await tx
            .update(authSessions)
            .set({ revokedAt: new Date(), revokeReason: 'reuse_detected' })
            .where(and(eq(authSessions.familyId, session.familyId), isNull(authSessions.revokedAt)));
          return { error: ERROR_CODES.REFRESH_REUSED, tokens: undefined } as const;
        }
        return { error: ERROR_CODES.REFRESH_INVALID, tokens: undefined } as const;
      }
      if (session.expiresAt.getTime() <= Date.now()) return { error: ERROR_CODES.REFRESH_INVALID, tokens: undefined } as const;

      const [user] = await tx.select({ status: users.status }).from(users).where(eq(users.id, session.userId));
      if (user?.status !== 'active') return { error: ERROR_CODES.USER_BLOCKED, tokens: undefined } as const;

      await tx
        .update(authSessions)
        .set({ revokedAt: new Date(), revokeReason: 'rotated', lastUsedAt: new Date() })
        .where(eq(authSessions.id, session.id));
      const tokens = await this.insertSession(
        tx,
        session.userId,
        session.app,
        { ...meta, deviceId: meta.deviceId ?? session.deviceId ?? undefined },
        session.familyId,
      );
      return { tokens } as const;
    });

    if (outcome.tokens === undefined) {
      const code = outcome.error;
      const status = code === ERROR_CODES.USER_BLOCKED ? HttpStatus.FORBIDDEN : HttpStatus.UNAUTHORIZED;
      throw new AppException(code, 'Сессия недействительна, войдите заново', status);
    }
    return outcome.tokens;
  }

  async revoke(sessionId: string, reason: 'logout' | 'admin' | 'user_blocked'): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date(), revokeReason: reason })
      .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)));
  }

  async revokeAllForUser(userId: string, reason: 'admin' | 'user_blocked'): Promise<void> {
    await this.db
      .update(authSessions)
      .set({ revokedAt: new Date(), revokeReason: reason })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
  }

  /** Активна ли сессия и пользователь — проверяется на каждом запросе, чтобы выход и блокировка действовали сразу. */
  async isActive(sessionId: string, userId: string): Promise<'ok' | 'revoked' | 'blocked'> {
    const [row] = await this.db
      .select({ revokedAt: authSessions.revokedAt, expiresAt: authSessions.expiresAt, status: users.status })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)));
    if (!row) return 'revoked';
    if (row.status !== 'active') return 'blocked';
    return row.revokedAt === null && row.expiresAt.getTime() > Date.now() ? 'ok' : 'revoked';
  }

  private async insertSession(
    db: Pick<Database, 'insert'>,
    userId: string,
    app: ClientApp,
    meta: SessionMeta,
    familyId: string,
  ): Promise<IssuedTokens> {
    const [accessTtl, refreshDays] = await Promise.all([
      this.settings.get('access_token_ttl_sec'),
      this.settings.get('refresh_token_ttl_days'),
    ]);
    const refreshToken = randomBytes(32).toString('base64url');
    const [session] = await db
      .insert(authSessions)
      .values({
        userId,
        app,
        familyId,
        refreshTokenHash: hashToken(refreshToken),
        deviceId: meta.deviceId ?? null,
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
        ip: meta.ip,
        expiresAt: new Date(Date.now() + refreshDays * 86_400_000),
      })
      .returning({ id: authSessions.id });
    if (!session) throw new Error('Не удалось создать сессию');
    const payload: AccessTokenPayload = { sub: userId, sid: session.id, app };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: accessTtl });
    return { accessToken, refreshToken, accessTokenExpiresIn: accessTtl, sessionId: session.id };
  }
}
