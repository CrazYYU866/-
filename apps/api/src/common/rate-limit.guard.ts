import { CanActivate, ExecutionContext, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@kovsh/contracts';
import type { Request, Response } from 'express';
import type Redis from 'ioredis';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { REDIS } from '../redis/redis.module';
import { AppException } from './app-exception';

/**
 * Ограничение частоты запросов с одного IP (защита API от перебора и перегрузки, ТЗ §19).
 * Счётчик в Redis — общий для всех экземпляров сервера. Отдельный, более строгий лимит — на вход
 * (SMS-коды, обновление токена, вход администратора); у SMS-кодов есть ещё свои лимиты на номер.
 * Вебхуки платёжного провайдера не ограничиваются (их защищает проверка подписи).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(@Inject(REDIS) private readonly redis: Redis, @Inject(APP_ENV) private readonly env: AppEnv) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (ctx.getType() !== 'http') return true;
    const req = ctx.switchToHttp().getRequest<Request>();
    const path = req.path ?? req.url;
    if (path.includes('/webhooks/') || path.endsWith('/health')) return true;
    const auth = /\/(auth|admin\/auth)\//.test(path);
    const limit = auth ? this.env.RATE_LIMIT_AUTH_PER_MIN : this.env.RATE_LIMIT_PER_MIN;
    if (limit <= 0) return true;
    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const window = Math.floor(Date.now() / 60_000);
    const key = `rl:${auth ? 'auth' : 'api'}:${ip}:${window}`;
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, 70);
    const res = ctx.switchToHttp().getResponse<Response>();
    res.setHeader('RateLimit-Limit', String(limit));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - count)));
    if (count > limit) {
      res.setHeader('Retry-After', String(60 - (Math.floor(Date.now() / 1000) % 60)));
      throw new AppException(ERROR_CODES.RATE_LIMITED, 'Слишком много запросов. Подождите минуту и повторите.', HttpStatus.TOO_MANY_REQUESTS);
    }
    return true;
  }
}
