import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import { AdminModule } from './admin/admin.module';
import { AgentModule } from './agent/agent.module';
import { AuthModule } from './auth/auth.module';
import { CatalogModule } from './catalog/catalog.module';
import { EquipmentModule } from './equipment/equipment.module';
import { FinanceCoreModule } from './finance/finance-core.module';
import { GeoModule } from './geo/geo.module';
import { JobsModule } from './jobs/jobs.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { PricingModule } from './pricing/pricing.module';
import { CommonModule } from './common/common.module';
import { FilesModule } from './files/files.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { ConfigModule } from './config/config.module';
import { loadEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { RedisModule } from './redis/redis.module';
import { SettingsModule } from './settings/settings.module';

const env = loadEnv();

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env.LOG_LEVEL,
        genReqId: (req) => (req.headers['x-request-id'] as string | undefined) ?? randomUUID(),
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
        autoLogging: env.NODE_ENV !== 'test',
      },
    }),
    ConfigModule,
    DatabaseModule,
    RedisModule,
    SettingsModule,
    HealthModule,
    CommonModule,
    AuthModule,
    FilesModule,
    OrganizationsModule,
    AdminModule,
    CatalogModule,
    EquipmentModule,
    GeoModule,
    PricingModule,
    JobsModule,
    FinanceCoreModule,
    OrdersModule,
    PaymentsModule,
    AgentModule,
  ],
  providers: [{ provide: APP_FILTER, useClass: HttpExceptionFilter }],
})
export class AppModule {}
