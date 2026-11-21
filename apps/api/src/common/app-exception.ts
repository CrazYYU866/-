import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '@kovsh/contracts';

/** Бизнес-ошибка с машиночитаемым кодом. Отдаётся клиенту в едином формате. */
export class AppException extends HttpException {
  constructor(
    public readonly code: ErrorCode | string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}
