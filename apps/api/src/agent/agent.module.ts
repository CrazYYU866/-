import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { PricingModule } from '../pricing/pricing.module';
import { AgentController } from './agent.controller';

@Module({ imports: [PricingModule, OrdersModule, OrganizationsModule], controllers: [AgentController] })
export class AgentModule {}
