import { forwardRef, Module } from '@nestjs/common';
import { AdminModule } from '../admin/admin.module';
import { BankAccountService } from './bank-account.service';
import { DocumentsService } from './documents.service';
import { ACTIVE_ORDERS_CHECK, MembersService, type ActiveOrdersCheck } from './members.service';
import { OrgContextGuard } from './org-context.guard';
import { OrganizationsService } from './organizations.service';
import { PartnerMembersController } from './partner-members.controller';
import { PartnerOrganizationsController } from './partner-organizations.controller';

/** До появления модуля заказов (этап 6) незавершённых заказов не существует. */
const noOrdersYet: ActiveOrdersCheck = { hasUnfinishedOrders: async () => false };

@Module({
  imports: [forwardRef(() => AdminModule)],
  controllers: [PartnerOrganizationsController, PartnerMembersController],
  providers: [
    OrganizationsService,
    MembersService,
    DocumentsService,
    BankAccountService,
    OrgContextGuard,
    { provide: ACTIVE_ORDERS_CHECK, useValue: noOrdersYet },
  ],
  exports: [OrganizationsService, MembersService, DocumentsService, OrgContextGuard],
})
export class OrganizationsModule {}
