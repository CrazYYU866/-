import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ERROR_CODES } from '@kovsh/contracts';
import { AppException } from '../common/app-exception';
import type { AuthedRequest } from './current-user';
import { SessionService, type AccessTokenPayload } from './session.service';

/** Проверяет access-токен, активность сессии и пользователя. */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest & { headers: Record<string, string | undefined> }>();
    const header = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) throw this.unauthorized();

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(header.slice(7));
    } catch {
      throw this.unauthorized();
    }

    const state = await this.sessions.isActive(payload.sid, payload.sub);
    if (state === 'blocked') {
      throw new AppException(ERROR_CODES.USER_BLOCKED, 'Аккаунт заблокирован', HttpStatus.FORBIDDEN);
    }
    if (state !== 'ok') throw this.unauthorized();

    req.user = { userId: payload.sub, sessionId: payload.sid, app: payload.app };
    return true;
  }

  private unauthorized(): AppException {
    return new AppException(ERROR_CODES.UNAUTHORIZED, 'Требуется авторизация', HttpStatus.UNAUTHORIZED);
  }
}
