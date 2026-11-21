import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RejectSchema, UNIT_VERIFICATION_STATUSES, type UnitVerificationStatus } from '@kovsh/contracts';
import { AdminAuthGuard, AdminRoles, CurrentAdmin, type AuthAdmin } from '../admin/admin-auth.guard';
import { AuditService } from '../audit/audit.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DocumentsService } from '../organizations/documents.service';
import { EquipmentService } from './equipment.service';
import { z } from 'zod';

@ApiTags('admin: техника')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin/equipment')
export class AdminEquipmentController {
  constructor(
    private readonly equipment: EquipmentService,
    private readonly docs: DocumentsService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  queue(@Query('status', new ZodValidationPipe(z.enum(UNIT_VERIFICATION_STATUSES).default('pending'))) status: UnitVerificationStatus) {
    return this.equipment.moderationQueue(status);
  }

  @Get(':id')
  async card(@Param('id', ParseUUIDPipe) id: string) {
    const [unit, documents] = await Promise.all([this.equipment.view(id, true), this.docs.list('equipment', id)]);
    return { unit, documentFiles: documents };
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'moderator')
  async approve(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    const unit = await this.equipment.review(id, 'approved', null, a.adminId);
    await this.audit.log({ adminId: a.adminId, action: 'equipment.approve', entity: 'equipment_unit', entityId: id, ip: a.ip });
    return unit;
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin', 'moderator')
  async reject(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(RejectSchema)) dto: { reason: string }) {
    const unit = await this.equipment.review(id, 'rejected', dto.reason, a.adminId);
    await this.audit.log({ adminId: a.adminId, action: 'equipment.reject', entity: 'equipment_unit', entityId: id, reason: dto.reason, ip: a.ip });
    return unit;
  }

  @Post(':id/force-offline')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminRoles('superadmin', 'moderator', 'support')
  async forceOffline(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.equipment.forceOffline(id);
    await this.audit.log({ adminId: a.adminId, action: 'equipment.force_offline', entity: 'equipment_unit', entityId: id, ip: a.ip });
  }
}
