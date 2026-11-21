import { Global, Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { JobsService } from './jobs.service';

@Global()
@Module({ providers: [JobsService, EventsService], exports: [JobsService, EventsService] })
export class JobsModule {}
