import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  RegisterPushDeviceSchema,
  UpdateMeSchema,
  type MeResponse,
  type RegisterPushDevice,
  type UpdateMe,
} from '@kovsh/contracts';
import { CurrentUser, type AuthUser } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { toMe, UsersService } from './users.service';

@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeController {
  constructor(private readonly users: UsersService) {}

  @Get()
  async me(@CurrentUser() user: AuthUser): Promise<MeResponse> {
    return toMe(await this.users.getById(user.userId));
  }

  @Patch()
  async update(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(UpdateMeSchema)) dto: UpdateMe,
  ): Promise<MeResponse> {
    return toMe(await this.users.updateProfile(user.userId, dto.fullName));
  }

  @Post('push-devices')
  @HttpCode(HttpStatus.NO_CONTENT)
  async registerPush(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(RegisterPushDeviceSchema)) dto: RegisterPushDevice,
  ): Promise<void> {
    await this.users.registerPushDevice(user.userId, user.app, dto);
  }

  @Delete('push-devices/:token')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removePush(@CurrentUser() user: AuthUser, @Param('token') token: string): Promise<void> {
    await this.users.removePushDevice(user.userId, token);
  }
}
