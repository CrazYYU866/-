import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';

/**
 * Socket.IO через Redis: события чата, статусов и GPS доходят до клиентов, подключённых к любому экземпляру
 * сервера (несколько экземпляров API за балансировщиком; задания тоже выполняются на любом из них).
 */
export class RedisIoAdapter extends IoAdapter {
  private pub: Redis | null = null;
  private sub: Redis | null = null;

  constructor(app: INestApplicationContext, private readonly redisUrl: string) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options) as { adapter: (a: unknown) => void };
    this.pub ??= new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    this.sub ??= this.pub.duplicate();
    server.adapter(createAdapter(this.pub, this.sub));
    return server;
  }

  /** Вызывается Nest при закрытии приложения. */
  override async dispose(): Promise<void> {
    await super.dispose();
    await Promise.allSettled([this.pub?.quit(), this.sub?.quit()]);
    this.pub = null;
    this.sub = null;
  }
}
