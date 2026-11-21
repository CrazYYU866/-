import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  AdminLoginSchema,
  BlockUserSchema,
  CreateAdminSchema,
  ERROR_CODES,
  ORGANIZATION_STATUSES,
  RefreshRequestSchema,
  RejectSchema,
  TotpConfirmSchema,
  TransferOwnershipSchema,
  UpdateAdminSchema,
  UpdateSettingSchema,
  isSettingKey,
  type AdminLogin,
  type CreateAdmin,
  type OrganizationStatus,
  type RefreshRequest,
  type TransferOwnership,
  type UpdateAdmin,
} from '@kovsh/contracts';
import { desc, eq } from 'drizzle-orm';
import type { Request, Response } from 'express';
import { Inject } from '@nestjs/common';
import { z } from 'zod';
import { AuditService } from '../audit/audit.service';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DB, type Database } from '../database/database.module';
import { adminAuditLog, adminUsers } from '../database/schema';
import { FilesService } from '../files/files.service';
import { SettingsService } from '../settings/settings.service';
import { AdminAuthGuard, AdminRoles, CurrentAdmin, type AuthAdmin } from './admin-auth.guard';
import { AdminAuthService } from './admin-auth.service';
import { ModerationService } from './moderation.service';

const toAdminView = (a: typeof adminUsers.$inferSelect) => ({
  id: a.id, email: a.email, fullName: a.fullName, role: a.role, status: a.status, totpEnabled: a.totpEnabled,
  lastLoginAt: a.lastLoginAt?.toISOString() ?? null, createdAt: a.createdAt.toISOString(),
});

@ApiTags('admin: вход')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService, @Inject(DB) private readonly db: Database) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  login(@Body(new ZodValidationPipe(AdminLoginSchema)) dto: AdminLogin, @Req() req: Request) {
    return this.auth.login(dto.email, dto.password, dto.totpCode, req.ip ?? null, req.headers['user-agent']);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  refresh(@Body(new ZodValidationPipe(RefreshRequestSchema)) dto: RefreshRequest, @Req() req: Request) {
    return this.auth.refresh(dto.refreshToken, req.ip ?? null);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(AdminAuthGuard)
  async logout(@CurrentAdmin() admin: AuthAdmin): Promise<void> {
    await this.auth.logout(admin.sessionId);
  }

  @Get('me')
  @ApiBearerAuth()
  @UseGuards(AdminAuthGuard)
  async me(@CurrentAdmin() admin: AuthAdmin) {
    const [a] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, admin.adminId));
    if (!a) throw new AppException(ERROR_CODES.NOT_FOUND, 'Не найден', HttpStatus.NOT_FOUND);
    return toAdminView(a);
  }

  @Post('2fa/setup')
  @ApiBearerAuth()
  @UseGuards(AdminAuthGuard)
  setup2fa(@CurrentAdmin() admin: AuthAdmin) {
    return this.auth.setupTotp(admin.adminId);
  }

  @Post('2fa/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @UseGuards(AdminAuthGuard)
  async confirm2fa(@CurrentAdmin() admin: AuthAdmin, @Body(new ZodValidationPipe(TotpConfirmSchema)) dto: { code: string }): Promise<void> {
    await this.auth.confirmTotp(admin.adminId, dto.code);
  }
}

@ApiTags('admin: администраторы')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@AdminRoles('superadmin')
@Controller('admin/admins')
export class AdminAdminsController {
  constructor(
    private readonly auth: AdminAuthService,
    private readonly audit: AuditService,
    @Inject(DB) private readonly db: Database,
  ) {}

  @Get()
  async list() {
    return (await this.db.select().from(adminUsers).orderBy(adminUsers.createdAt)).map(toAdminView);
  }

  @Post()
  async create(@CurrentAdmin() admin: AuthAdmin, @Body(new ZodValidationPipe(CreateAdminSchema)) dto: CreateAdmin) {
    return toAdminView(await this.auth.createAdmin(dto, admin.adminId));
  }

  @Patch(':id')
  async update(
    @CurrentAdmin() admin: AuthAdmin,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodValidationPipe(UpdateAdminSchema)) dto: UpdateAdmin,
  ) {
    if (id === admin.adminId) {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Нельзя менять собственную роль или статус', HttpStatus.FORBIDDEN);
    }
    const [before] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, id));
    if (!before) throw new AppException(ERROR_CODES.NOT_FOUND, 'Не найден', HttpStatus.NOT_FOUND);
    const [after] = await this.db.update(adminUsers).set(dto).where(eq(adminUsers.id, id)).returning();
    if (!after) throw new AppException(ERROR_CODES.NOT_FOUND, 'Не найден', HttpStatus.NOT_FOUND);
    await this.audit.log({ adminId: admin.adminId, action: 'admin.update', entity: 'admin_user', entityId: id, before: { role: before.role, status: before.status }, after: { role: after.role, status: after.status }, ip: admin.ip });
    return toAdminView(after);
  }
}

@ApiTags('admin: настройки')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly settings: SettingsService, private readonly audit: AuditService) {}

  @Get()
  @AdminRoles('superadmin', 'finance')
  list() {
    return this.settings.list();
  }

  @Patch(':key')
  @AdminRoles('superadmin')
  async update(
    @CurrentAdmin() admin: AuthAdmin,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(UpdateSettingSchema)) dto: { value?: unknown; reason?: string | undefined },
  ) {
    if (!isSettingKey(key)) throw new AppException(ERROR_CODES.NOT_FOUND, 'Неизвестный параметр', HttpStatus.NOT_FOUND);
    const before = (await this.settings.list()).find((s) => s.key === key)?.value ?? null;
    const value = await this.settings.set(key, dto.value, admin.adminId, dto.reason);
    await this.audit.log({ adminId: admin.adminId, action: 'setting.update', entity: 'setting', entityId: key, before, after: value, reason: dto.reason ?? null, ip: admin.ip });
    return { key, value };
  }
}

const OrgListQuery = z.object({ status: z.enum(ORGANIZATION_STATUSES).optional(), q: z.string().max(100).optional() });
const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(2000) });
const ReviewSchema = z.object({ comment: z.string().trim().max(2000).optional() });

@ApiTags('admin: организации и документы')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin')
export class AdminModerationController {
  constructor(private readonly moderation: ModerationService, private readonly files: FilesService) {}

  @Get('organizations')
  organizations(@Query(new ZodValidationPipe(OrgListQuery)) q: { status?: OrganizationStatus; q?: string }) {
    return this.moderation.listOrganizations(q.status, q.q);
  }

  @Get('organizations/:id')
  organization(@Param('id', ParseUUIDPipe) id: string) {
    return this.moderation.organizationCard(id);
  }

  @Post('organizations/:id/approve')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'moderator')
  approve(@CurrentAdmin() admin: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    return this.moderation.approveOrganization(id, admin);
  }

  @Post('organizations/:id/reject')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'moderator')
  reject(@CurrentAdmin() admin: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(RejectSchema)) dto: { reason: string }) {
    return this.moderation.rejectOrganization(id, dto.reason, admin);
  }

  @Post('organizations/:id/block')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'support')
  block(@CurrentAdmin() admin: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ReasonSchema)) dto: { reason: string }) {
    return this.moderation.blockOrganization(id, dto.reason, admin);
  }

  @Post('organizations/:id/unblock')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'support')
  unblock(@CurrentAdmin() admin: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    return this.moderation.unblockOrganization(id, admin);
  }

  @Post('organizations/:id/transfer-ownership')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'support')
  transfer(@CurrentAdmin() admin: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(TransferOwnershipSchema)) dto: TransferOwnership) {
    return this.moderation.transferOwnership(id, dto, admin);
  }

  @Get('documents')
  @AdminRoles('superadmin', 'moderator')
  documents(@Query('status') status?: 'uploaded' | 'approved' | 'rejected') {
    return this.moderation.documentQueue(status ?? 'uploaded');
  }

  @Post('documents/:id/approve')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'moderator')
  approveDoc(@CurrentAdmin() admin: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ReviewSchema)) dto: { comment?: string }) {
    return this.moderation.reviewDocument(id, 'approved', dto.comment ?? null, admin);
  }

  @Post('documents/:id/reject')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'moderator')
  rejectDoc(@CurrentAdmin() admin: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(RejectSchema)) dto: { reason: string }) {
    return this.moderation.reviewDocument(id, 'rejected', dto.reason, admin);
  }

  @Get('files/:id/content')
  @AdminRoles('superadmin', 'moderator', 'support')
  async file(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    const { meta, body } = await this.files.read(id);
    res.setHeader('Content-Type', meta.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(body);
  }

  @Get('users')
  @AdminRoles('superadmin', 'support')
  users(@Query('phone') phone?: string) {
    return this.moderation.listUsers(phone);
  }

  @Post('users/:id/block')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'support')
  blockUser(@CurrentAdmin() admin: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(BlockUserSchema)) dto: { reason: string }) {
    return this.moderation.setUserBlocked(id, true, dto.reason, admin);
  }

  @Post('users/:id/unblock')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'support')
  unblockUser(@CurrentAdmin() admin: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    return this.moderation.setUserBlocked(id, false, null, admin);
  }
}

@ApiTags('admin: журнал')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@AdminRoles('superadmin')
@Controller('admin/audit-log')
export class AdminAuditController {
  constructor(@Inject(DB) private readonly db: Database) {}

  @Get()
  list(@Query('entity') entity?: string, @Query('entityId') entityId?: string) {
    const q = this.db.select().from(adminAuditLog);
    const where = entity && entityId ? eq(adminAuditLog.entityId, entityId) : entity ? eq(adminAuditLog.entity, entity) : undefined;
    return q.where(where).orderBy(desc(adminAuditLog.id)).limit(500);
  }
}
