import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AdminEquipmentController } from './admin-equipment.controller';
import { EquipmentService } from './equipment.service';
import { PartnerEquipmentController } from './partner-equipment.controller';

@Module({
  imports: [OrganizationsModule],
  controllers: [PartnerEquipmentController, AdminEquipmentController],
  providers: [EquipmentService],
  exports: [EquipmentService],
})
export class EquipmentModule {}
