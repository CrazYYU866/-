import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, type BankAccountRequest, type OtpRequestResponse } from '@kovsh/contracts';
import { and, eq } from 'drizzle-orm';
import { OtpService } from '../auth/otp.service';
import { AppException } from '../common/app-exception';
import { FieldCipher } from '../common/crypto/field-cipher';
import { DB, type Database } from '../database/database.module';
import { organizationBankAccounts, userActionLog } from '../database/schema';
import { UsersService } from '../users/users.service';

/** Банковские реквизиты: меняет только главный владелец, с SMS-кодом и записью в журнал (П-17). */
@Injectable()
export class BankAccountService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly otp: OtpService,
    private readonly users: UsersService,
    private readonly cipher: FieldCipher,
  ) {}

  async requestCode(userId: string, ip: string | null): Promise<OtpRequestResponse> {
    const user = await this.users.getById(userId);
    return this.otp.request(user.phone, 'partner', ip, 'bank_account_change');
  }

  async set(orgId: string, userId: string, dto: BankAccountRequest, ip: string | null): Promise<{ accountLast4: string }> {
    const user = await this.users.getById(userId);
    await this.otp.verify(user.phone, 'partner', dto.code, 'bank_account_change');
    if (!/^\d{20}$/.test(dto.accountNumber)) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Номер счёта — 20 цифр', HttpStatus.BAD_REQUEST);
    }
    const last4 = dto.accountNumber.slice(-4);
    await this.db.transaction(async (tx) => {
      await tx
        .update(organizationBankAccounts)
        .set({ isCurrent: false })
        .where(and(eq(organizationBankAccounts.orgId, orgId), eq(organizationBankAccounts.isCurrent, true)));
      const [row] = await tx
        .insert(organizationBankAccounts)
        .values({
          orgId,
          bik: dto.bik,
          accountNumberEnc: this.cipher.encrypt(dto.accountNumber),
          accountNumberLast4: last4,
          correspondentAccount: dto.correspondentAccount,
          bankName: dto.bankName,
          createdBy: userId,
        })
        .returning({ id: organizationBankAccounts.id });
      await tx.insert(userActionLog).values({
        userId,
        orgId,
        action: 'bank_account.changed',
        entity: 'organization_bank_account',
        entityId: row?.id ?? null,
        details: { bik: dto.bik, accountLast4: last4 },
        ip,
      });
    });
    return { accountLast4: last4 };
  }
}
