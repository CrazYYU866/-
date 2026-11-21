import { HttpStatus, type PipeTransform } from '@nestjs/common';
import { ERROR_CODES } from '@kovsh/contracts';
import type { ZodType } from 'zod';
import { AppException } from './app-exception';

/** Проверяет входные данные zod-схемой из @kovsh/contracts. */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new AppException(
        ERROR_CODES.VALIDATION_FAILED,
        'Некорректные входные данные',
        HttpStatus.BAD_REQUEST,
        parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      );
    }
    return parsed.data;
  }
}
