import { Module } from '@nestjs/common';
import { OrganizationsModule } from '../organizations/organizations.module';
import { AdminOrdersController } from './admin-orders.controller';
import { AssignmentService } from './assignment.service';
import { ClientOrdersController } from './client-orders.controller';
import { MatchingService } from './matching.service';
import { OperatorService } from './operator.service';
import { OrderCore } from './order-core';
import { OrdersService } from './orders.service';
import { OperatorController, PartnerOrdersController } from './partner-orders.controller';

@Module({
  imports: [OrganizationsModule],
  controllers: [ClientOrdersController, PartnerOrdersController, OperatorController, AdminOrdersController],
  providers: [OrderCore, MatchingService, AssignmentService, OrdersService, OperatorService],
  exports: [OrderCore, MatchingService, AssignmentService, OrdersService],
})
export class OrdersModule {}
