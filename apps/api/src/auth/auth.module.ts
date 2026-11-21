import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { SettingsModule } from '../settings/settings.module';
import { UsersService } from '../users/users.service';
import { MeController } from '../users/me.controller';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OtpService } from './otp.service';
import { SessionService } from './session.service';
import { DevSmsProvider } from './sms/dev-sms.provider';
import { SMS_PROVIDER } from './sms/sms.provider';

@Global()
@Module({
  imports: [
    SettingsModule,
    JwtModule.registerAsync({
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => ({ secret: env.JWT_ACCESS_SECRET, signOptions: { algorithm: 'HS256' } }),
    }),
  ],
  controllers: [AuthController, MeController],
  providers: [
    OtpService,
    SessionService,
    UsersService,
    JwtAuthGuard,
    {
      provide: SMS_PROVIDER,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => {
        switch (env.SMS_PROVIDER) {
          case 'dev':
            return new DevSmsProvider();
        }
      },
    },
  ],
  exports: [SessionService, UsersService, JwtAuthGuard, JwtModule, SMS_PROVIDER, OtpService],
})
export class AuthModule {}
