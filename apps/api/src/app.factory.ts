import { type INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { loadEnv } from './config/env';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

export const API_PREFIX = 'api/v1';

/** Создаёт и настраивает приложение. Используется и в main.ts, и в e2e-тестах. */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  if (loadEnv().TRUST_PROXY) app.set('trust proxy', true);
  app.useLogger(app.get(Logger));
  app.setGlobalPrefix(API_PREFIX);
  app.enableShutdownHooks();

  const config = new DocumentBuilder()
    .setTitle('Ковш на Час API')
    .setDescription('REST API мобильных приложений и административной панели')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, () => SwaggerModule.createDocument(app, config));
  return app;
}
