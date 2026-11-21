import { Global, Module } from '@nestjs/common';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { DevRoutingProvider } from './dev-routing.provider';
import { ROUTING } from './routing.provider';

@Global()
@Module({
  providers: [
    {
      provide: ROUTING,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) => {
        switch (env.ROUTING_PROVIDER) {
          case 'dev':
            return new DevRoutingProvider();
        }
      },
    },
  ],
  exports: [ROUTING],
})
export class GeoModule {}
