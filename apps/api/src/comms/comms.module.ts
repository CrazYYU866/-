import { Module } from '@nestjs/common';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { OrdersModule } from '../orders/orders.module';
import { OrganizationsModule } from '../organizations/organizations.module';
import { CallsService } from './calls.service';
import { ChatService } from './chat.service';
import {
  AdminCommsController, NotificationsController, OperatorLocationsController, OrderCommsController, PublicCommsController, RatingComplaintsController,
} from './comms.controllers';
import { NotificationsService } from './notifications.service';
import { DevPushProvider, PUSH_PROVIDER } from './push.provider';
import { RatingsService } from './ratings.service';
import { RealtimeGateway } from './realtime.gateway';
import { RetentionService } from './retention.service';
import { DevTelephonyProvider, TELEPHONY_PROVIDER } from './telephony.provider';
import { TrackingService } from './tracking.service';

@Module({
  imports: [OrdersModule, OrganizationsModule],
  controllers: [NotificationsController, RatingComplaintsController, OrderCommsController, OperatorLocationsController, PublicCommsController, AdminCommsController],
  providers: [
    RealtimeGateway, NotificationsService, ChatService, CallsService, TrackingService, RatingsService, RetentionService,
    {
      provide: PUSH_PROVIDER,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => {
        switch (env.PUSH_PROVIDER) {
          case 'dev':
            return new DevPushProvider();
        }
      },
    },
    {
      provide: TELEPHONY_PROVIDER,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => {
        switch (env.TELEPHONY_PROVIDER) {
          case 'dev':
            return new DevTelephonyProvider();
        }
      },
    },
  ],
  exports: [NotificationsService, RetentionService],
})
export class CommsModule {}
