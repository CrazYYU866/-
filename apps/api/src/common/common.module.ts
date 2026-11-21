import { Global, Module } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { FieldCipher } from './crypto/field-cipher';

@Global()
@Module({ providers: [FieldCipher, AuditService], exports: [FieldCipher, AuditService] })
export class CommonModule {}
