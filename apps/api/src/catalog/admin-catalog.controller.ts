import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  CreateAttributeSchema,
  CreateCategorySchema,
  CreateRegionSchema,
  CreateTariffSchema,
  ImportZoneSchema,
  MeasureUnitSchema,
  TARIFF_KINDS,
  UpdateAttributeSchema,
  UpdateCategorySchema,
  UpdateRegionSchema,
  type CreateAttribute,
  type CreateCategory,
  type CreateRegion,
  type CreateTariff,
  type ImportZone,
  type MeasureUnitInput,
  type UpdateAttribute,
  type UpdateCategory,
} from '@kovsh/contracts';
import { z } from 'zod';
import { AdminAuthGuard, AdminRoles, CurrentAdmin, type AuthAdmin } from '../admin/admin-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CatalogAdminService } from './catalog-admin.service';
import { CatalogService } from './catalog.service';

const TariffQuery = z.object({
  categoryId: z.string().uuid().optional(),
  regionId: z.string().uuid().optional(),
  kind: z.enum(TARIFF_KINDS).optional(),
});

/**
 * Управление каталогом, регионами и тарифами. Просмотр — любой администратор,
 * изменения — суперадминистратор (С-11).
 */
@ApiTags('admin: каталог и тарифы')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin')
export class AdminCatalogController {
  constructor(private readonly admin: CatalogAdminService, private readonly catalog: CatalogService) {}

  @Get('catalog/categories')
  tree() {
    return this.catalog.tree('admin');
  }

  @Post('catalog/categories')
  @AdminRoles('superadmin')
  createCategory(@CurrentAdmin() a: AuthAdmin, @Body(new ZodValidationPipe(CreateCategorySchema)) dto: CreateCategory) {
    return this.admin.createCategory(dto, a);
  }

  @Patch('catalog/categories/:id')
  @AdminRoles('superadmin')
  updateCategory(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateCategorySchema)) dto: UpdateCategory) {
    return this.admin.updateCategory(id, dto, a);
  }

  @Post('catalog/categories/:id/archive')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin')
  archive(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.setCategoryArchived(id, true, a);
  }

  @Post('catalog/categories/:id/unarchive')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin')
  unarchive(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.setCategoryArchived(id, false, a);
  }

  @Delete('catalog/categories/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminRoles('superadmin')
  async deleteCategory(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.admin.deleteCategory(id, a);
  }

  @Post('catalog/categories/:id/attributes')
  @AdminRoles('superadmin')
  createAttribute(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(CreateAttributeSchema)) dto: CreateAttribute) {
    return this.admin.createAttribute(id, dto, a);
  }

  @Patch('catalog/attributes/:id')
  @AdminRoles('superadmin')
  updateAttribute(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateAttributeSchema)) dto: UpdateAttribute) {
    return this.admin.updateAttribute(id, dto, a);
  }

  @Delete('catalog/attributes/:id')
  @AdminRoles('superadmin')
  removeAttribute(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.removeAttribute(id, a);
  }

  @Get('catalog/units')
  units() {
    return this.admin.listUnits();
  }

  @Post('catalog/units')
  @AdminRoles('superadmin')
  createUnit(@CurrentAdmin() a: AuthAdmin, @Body(new ZodValidationPipe(MeasureUnitSchema)) dto: MeasureUnitInput) {
    return this.admin.createUnit(dto, a);
  }

  @Patch('catalog/units/:id')
  @AdminRoles('superadmin')
  updateUnit(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(MeasureUnitSchema.partial())) dto: Partial<MeasureUnitInput>) {
    return this.admin.updateUnit(id, dto, a);
  }

  @Get('catalog/history')
  history(@Query('entity') entity?: string, @Query('entityId') entityId?: string) {
    return this.admin.history(entity, entityId);
  }

  @Get('regions')
  regions() {
    return this.catalog.listRegions(false);
  }

  @Post('regions')
  @AdminRoles('superadmin')
  createRegion(@CurrentAdmin() a: AuthAdmin, @Body(new ZodValidationPipe(CreateRegionSchema)) dto: CreateRegion) {
    return this.admin.createRegion(dto, a);
  }

  @Patch('regions/:id')
  @AdminRoles('superadmin')
  updateRegion(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateRegionSchema)) dto: Partial<CreateRegion>) {
    return this.admin.updateRegion(id, dto, a);
  }

  @Get('regions/:id/zones')
  zones(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.listZones(id);
  }

  @Post('regions/:id/zones')
  @AdminRoles('superadmin')
  importZone(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ImportZoneSchema)) dto: ImportZone) {
    return this.admin.importZone(id, dto, a);
  }

  @Post('zones/:id/disable')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin')
  disableZone(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.setZoneActive(id, false, a);
  }

  @Post('zones/:id/enable')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin')
  enableZone(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.setZoneActive(id, true, a);
  }

  @Get('tariffs')
  tariffs(@Query(new ZodValidationPipe(TariffQuery)) q: z.infer<typeof TariffQuery>) {
    return this.admin.listTariffs(q);
  }

  @Post('tariffs')
  @AdminRoles('superadmin')
  createTariff(@CurrentAdmin() a: AuthAdmin, @Body(new ZodValidationPipe(CreateTariffSchema)) dto: CreateTariff) {
    return this.admin.createTariff(dto, a);
  }

  @Post('tariffs/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @AdminRoles('superadmin')
  cancelTariff(@CurrentAdmin() a: AuthAdmin, @Param('id', ParseUUIDPipe) id: string) {
    return this.admin.cancelTariff(id, a);
  }
}
