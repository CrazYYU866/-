import { Global, Module } from '@nestjs/common';
import { LedgerService } from './ledger.service';
import { SettlementService } from './settlement.service';

@Global()
@Module({ providers: [LedgerService, SettlementService], exports: [LedgerService, SettlementService] })
export class FinanceCoreModule {}
