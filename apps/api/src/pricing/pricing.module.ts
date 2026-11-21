import { Module } from '@nestjs/common';
import { ClientQuotesController } from './client-quotes.controller';
import { PricingService } from './pricing.service';

@Module({ controllers: [ClientQuotesController], providers: [PricingService], exports: [PricingService] })
export class PricingModule {}
