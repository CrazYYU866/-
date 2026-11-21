import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import {
  AddPhotoSchema,
  CreateUnitSchema,
  ScheduleSchema,
  UpdateUnitSchema,
  UploadDocumentSchema,
  type CreateUnit,
  type Schedule,
  type UpdateUnit,
  type UploadDocument,
} from '@kovsh/contracts';
import { z } from 'zod';
import { CurrentUser, type AuthUser } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentOrg, OrgContextGuard, OrgRoles, type OrgContext } from '../organizations/org-context.guard';
import { EquipmentService } from './equipment.service';

const CalendarQuery = z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) });

/** Автопарк компании (ТЗ §6). Управляют руководители и диспетчеры (ТЗ §4). */
@ApiTags('partner: техника')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Org-Id', required: true })
@UseGuards(JwtAuthGuard, OrgContextGuard)
@OrgRoles('owner', 'manager', 'dispatcher')
@Controller('partner/equipment')
export class PartnerEquipmentController {
  constructor(private readonly equipment: EquipmentService) {}

  @Get()
  list(@CurrentOrg() org: OrgContext, @Query('archived') archived?: string) {
    return this.equipment.list(org.orgId, archived === 'true');
  }

  @Post()
  create(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(CreateUnitSchema)) dto: CreateUnit) {
    return this.equipment.create(org.orgId, user.userId, dto);
  }

  @Get(':id')
  get(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.equipment.view(id, true, org.orgId);
  }

  @Patch(':id')
  update(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateUnitSchema)) dto: UpdateUnit) {
    return this.equipment.update(org.orgId, id, user.userId, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async archive(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.equipment.archive(org.orgId, id, user.userId);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  submit(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.equipment.submit(org.orgId, id, user.userId);
  }

  @Post(':id/online')
  @HttpCode(HttpStatus.OK)
  online(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.equipment.setOnline(org.orgId, id, user.userId, true);
  }

  @Post(':id/offline')
  @HttpCode(HttpStatus.OK)
  offline(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.equipment.setOnline(org.orgId, id, user.userId, false);
  }

  @Put(':id/schedule')
  schedule(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ScheduleSchema)) dto: Schedule) {
    return this.equipment.setSchedule(org.orgId, id, dto);
  }

  @Get(':id/calendar')
  calendar(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(CalendarQuery)) q: z.infer<typeof CalendarQuery>) {
    return this.equipment.calendar(org.orgId, id, new Date(q.from), new Date(q.to));
  }

  @Post(':id/photos')
  addPhoto(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(AddPhotoSchema)) dto: { fileId: string }) {
    return this.equipment.addPhoto(org.orgId, id, user.userId, dto.fileId);
  }

  @Delete(':id/photos/:photoId')
  removePhoto(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string, @Param('photoId', ParseUUIDPipe) photoId: string) {
    return this.equipment.removePhoto(org.orgId, id, photoId);
  }

  @Get(':id/documents')
  documents(@CurrentOrg() org: OrgContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.equipment.documents(org.orgId, id);
  }

  @Post(':id/documents')
  uploadDocument(@CurrentOrg() org: OrgContext, @CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UploadDocumentSchema)) dto: UploadDocument) {
    return this.equipment.uploadDocument(org.orgId, id, user.userId, dto);
  }
}
