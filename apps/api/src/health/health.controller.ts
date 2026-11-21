import { Controller, Get, HttpStatus, Inject, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type Redis from 'ioredis';
import type { Pool } from 'pg';
import { PG_POOL } from '../database/database.module';
import { REDIS } from '../redis/redis.module';

type Check = 'ok' | 'fail';

@ApiTags('system')
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  @ApiOkResponse({ description: 'Состояние сервиса и зависимостей' })
  async check(@Res({ passthrough: true }) res: Response): Promise<{ status: Check; db: Check; postgis: Check; redis: Check }> {
    const [db, postgis, redis] = await Promise.all([
      this.pool.query('SELECT 1').then((): Check => 'ok', (): Check => 'fail'),
      this.pool.query('SELECT postgis_version()').then((): Check => 'ok', (): Check => 'fail'),
      this.redis.ping().then((r): Check => (r === 'PONG' ? 'ok' : 'fail'), (): Check => 'fail'),
    ]);
    const status: Check = db === 'ok' && postgis === 'ok' && redis === 'ok' ? 'ok' : 'fail';
    if (status !== 'ok') res.status(HttpStatus.SERVICE_UNAVAILABLE);
    return { status, db, postgis, redis };
  }
}
