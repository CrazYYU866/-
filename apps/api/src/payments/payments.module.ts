import { Module } from '@nestjs/common';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { OrdersModule } from '../orders/orders.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { CancellationService } from './cancellation.service';
import { DevPaymentProvider } from './dev-payment.provider';
import { AdminFinanceController, ClientFinanceController, DevPaymentsController, PartnerFinanceController, PaymentWebhooksController } from './finance.controllers';
import { PAYMENT_PROVIDER } from './payment.provider';
import { InvoicesService } from './invoices.service';
import { PaymentsService } from './payments.service';
import { PublicOrderController } from './public-order.controller';
import { PayoutsService } from './payouts.service';

@Module({
  imports: [OrdersModule, OrganizationsModule],
  controllers: [PublicOrderController, ClientFinanceController, PaymentWebhooksController, DevPaymentsController, AdminFinanceController, PartnerFinanceController],
  providers: [
    PaymentsService,
    CancellationService,
    PayoutsService,
    InvoicesService,
    {
      provide: PAYMENT_PROVIDER,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => {
        switch (env.PAYMENT_PROVIDER) {
          case 'dev':
            return new DevPaymentProvider(env.PUBLIC_BASE_URL);
        }
      },
    },
  ],
  exports: [PaymentsService, PayoutsService],
})
export class PaymentsModule {}
