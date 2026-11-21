import { Global, Module } from '@nestjs/common';
import { AdminCatalogController } from './admin-catalog.controller';
import { CatalogAdminService } from './catalog-admin.service';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Global()
@Module({
  controllers: [CatalogController, AdminCatalogController],
  providers: [CatalogService, CatalogAdminService],
  exports: [CatalogService],
})
export class CatalogModule {}
