import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadEnv } from './config/env';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './comms/redis-io.adapter';

export const API_PREFIX = 'api/v1';

/** Создаёт и настраивает приложение. Используется и в main.ts, и в e2e-тестах. */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  const env = loadEnv();
  if (env.TRUST_PROXY) app.set('trust proxy', true);
  // Защитные заголовки (ТЗ §19). CSP выключена: API отдаёт JSON, а тестовая страница оплаты — простая форма.
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.disable('x-powered-by');
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();
  app.useWebSocketAdapter(new RedisIoAdapter(app, env.REDIS_URL));

  const config = new DocumentBuilder()
    .setTitle('Ковш на Час API')
    .setDescription('REST API мобильных приложений и административной панели')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  // В production документация API открывается только явным SWAGGER_ENABLED=true.
  if (env.SWAGGER_ENABLED && (env.NODE_ENV !== 'production' || process.env['SWAGGER_ENABLED'] === 'true')) {
    SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, config));
  }
  return app;
}
