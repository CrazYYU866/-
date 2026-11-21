import { Global, Module } from '@nestjs/common';
import { APP_ENV } from '../config/config.module';
import type { AppEnv } from '../config/env';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { LocalStorage } from './storage/local.storage';
import { S3Storage } from './storage/s3.storage';
import { STORAGE } from './storage/storage.provider';

@Global()
@Module({
  controllers: [FilesController],
  providers: [
    FilesService,
    {
      provide: STORAGE,
      inject: [APP_ENV],
      useFactory: (env: AppEnv) =>
        env.STORAGE_DRIVER === 's3'
          ? new S3Storage(env.S3_BUCKET ?? '', {
              endpoint: env.S3_ENDPOINT,
              region: env.S3_REGION,
              accessKeyId: env.S3_ACCESS_KEY_ID ?? '',
              secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '',
            })
          : new LocalStorage(env.STORAGE_LOCAL_DIR),
    },
  ],
  exports: [FilesService],
})
export class FilesModule {}
