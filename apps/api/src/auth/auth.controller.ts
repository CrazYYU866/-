import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ERROR_CODES,
  OtpRequestSchema,
  OtpVerifySchema,
  RefreshRequestSchema,
  type AuthTokensResponse,
  type OtpRequest,
  type OtpRequestResponse,
  type OtpVerify,
  type RefreshRequest,
} from '@kovsh/contracts';
import type { Request } from 'express';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { toMe, UsersService } from '../users/users.service';
import { CurrentUser, type AuthUser } from './current-user';
import { JwtAuthGuard } from './jwt-auth.guard';
import { OtpService } from './otp.service';
import { normalizePhone } from './phone';
import { SessionService } from './session.service';

const clientIp = (req: Request): string | null => req.ip ?? null;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly otp: OtpService,
    private readonly sessions: SessionService,
    private readonly users: UsersService,
  ) {}

  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Отправить SMS-код на телефон' })
  async requestOtp(
    @Body(new ZodValidationPipe(OtpRequestSchema)) dto: OtpRequest,
    @Req() req: Request,
  ): Promise<OtpRequestResponse> {
    return this.otp.request(normalizePhone(dto.phone), dto.app, clientIp(req));
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Проверить код и войти (пользователь создаётся при первом входе)' })
  async verifyOtp(
    @Body(new ZodValidationPipe(OtpVerifySchema)) dto: OtpVerify,
    @Req() req: Request,
  ): Promise<AuthTokensResponse> {
    const phone = normalizePhone(dto.phone);
    await this.otp.verify(phone, dto.app, dto.code);
    const { user, isNew } = await this.users.findOrCreateByPhone(phone);
    if (user.status !== 'active') {
      throw new AppException(ERROR_CODES.USER_BLOCKED, 'Аккаунт заблокирован', HttpStatus.FORBIDDEN);
    }
    const tokens = await this.sessions.create(user.id, dto.app, {
      deviceId: dto.deviceId,
      userAgent: req.headers['user-agent'],
      ip: clientIp(req),
    });
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresIn: tokens.accessTokenExpiresIn,
      user: toMe(user),
      isNewUser: isNew,
    };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Обновить пару токенов (старый refresh-токен погашается)' })
  async refresh(
    @Body(new ZodValidationPipe(RefreshRequestSchema)) dto: RefreshRequest,
    @Req() req: Request,
  ): Promise<Omit<AuthTokensResponse, 'user' | 'isNewUser'>> {
    const t = await this.sessions.refresh(dto.refreshToken, { userAgent: req.headers['user-agent'], ip: clientIp(req) });
    return { accessToken: t.accessToken, refreshToken: t.refreshToken, accessTokenExpiresIn: t.accessTokenExpiresIn };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Выйти: текущая сессия отзывается' })
  async logout(@CurrentUser() user: AuthUser): Promise<void> {
    await this.sessions.revoke(user.sessionId, 'logout');
  }
}
