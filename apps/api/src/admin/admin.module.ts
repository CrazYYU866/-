import { AuthModule } from '../auth/auth.module';
import { Global, Module } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { OrganizationsModule } from '../organizations/organizations.module';
import {
  AdminAdminsController,
  AdminAuditController,
  AdminAuthController,
  AdminModerationController,
  AdminSettingsController,
  AdminDevSmsController,
} from './admin.controllers';
import { AdminAuthGuard } from './admin-auth.guard';
import { ADMIN_JWT, AdminAuthService } from './admin-auth.service';
import { ModerationService } from './moderation.service';

@Global()
@Module({
  imports: [OrganizationsModule, AuthModule],
  controllers: [AdminDevSmsController, AdminAuthController, AdminAdminsController, AdminSettingsController, AdminModerationController, AdminAuditController],
  providers: [
    AdminAuthService,
    AdminAuthGuard,
    ModerationService,
    {
      provide: ADMIN_JWT,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => new JwtService({ secret: env.ADMIN_JWT_SECRET, signOptions: { algorithm: 'HS256' } }),
    },
  ],
  exports: [ModerationService, AdminAuthService],
})
export class AdminModule {}
