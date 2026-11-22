import { Global, Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { PromoService } from './promo.service';
import { SettlementService } from './settlement.service';

@Global()
@Module({ providers: [LedgerService, SettlementService, PromoService], exports: [LedgerService, SettlementService, PromoService] })
export class FinanceCoreModule {}
