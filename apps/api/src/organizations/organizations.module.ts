import { forwardRef, Module } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../database/database.module';
import { AdminModule } from '../admin/admin.module';
import { BankAccountService } from './bank-account.service';
import { DocumentsService } from './documents.service';
import { ACTIVE_ORDERS_CHECK, MembersService, type ActiveOrdersCheck } from './members.service';
import { OrgContextGuard } from './org-context.guard';
import { OrganizationsService } from './organizations.service';
import { PartnerMembersController } from './partner-members.controller';
import { PartnerOrganizationsController } from './partner-organizations.controller';

/** Есть ли у машиниста незавершённые смены в заказах этой компании (Р-15, П-11). */
const activeOrdersCheck = {
  provide: ACTIVE_ORDERS_CHECK,
  inject: [DB],
  useFactory: (db: Database): ActiveOrdersCheck => ({
    hasUnfinishedOrders: async (orgId, userId) => {
      const res = await db.execute<{ ok: boolean }>(sql`
        SELECT true AS ok FROM order_shifts s JOIN orders o ON o.id = s.order_id
        WHERE o.partner_org_id = ${orgId} AND s.operator_user_id = ${userId} AND s.status NOT IN ('finished', 'cancelled')
          AND o.status NOT IN ('cancelled', 'cancelled_unpaid', 'search_failed', 'completed', 'refund_pending') LIMIT 1`);
      return Boolean(res.rows[0]);
    },
  }),
};

@Module({
  imports: [forwardRef(() => AdminModule)],
  controllers: [PartnerOrganizationsController, PartnerMembersController],
  providers: [
    OrganizationsService,
    MembersService,
    DocumentsService,
    BankAccountService,
    OrgContextGuard,
    activeOrdersCheck,
  ],
  exports: [OrganizationsService, MembersService, DocumentsService, OrgContextGuard],
})
export class OrganizationsModule {}
