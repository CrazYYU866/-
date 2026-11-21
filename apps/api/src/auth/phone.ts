import { HttpStatus } from '@nestjs/common';
import { ERROR_CODES } from '@kovsh/contracts';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { AppException } from '../common/app-exception';

/**
 * Приводит телефон к формату E.164. Номера без кода страны считаются российскими.
 * Принимаются только мобильные номера (на них уходит SMS).
 */
export function normalizePhone(input: string): string {
  const cleaned = input.trim().replace(/^8(?=\d{10}$)/, '+7');
  const parsed = parsePhoneNumberFromString(cleaned, 'RU');
  const type = parsed?.getType();
  if (!parsed || !parsed.isValid() || (type !== 'MOBILE' && type !== 'FIXED_LINE_OR_MOBILE')) {
    throw new AppException(ERROR_CODES.INVALID_PHONE, 'Укажите корректный мобильный номер', HttpStatus.BAD_REQUEST);
  }
  return parsed.number;
}
