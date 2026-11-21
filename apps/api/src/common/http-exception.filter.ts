import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ERROR_CODES, type ApiError } from '@kovsh/contracts';
import type { Request, Response } from 'express';
import { AppException } from './app-exception';

const STATUS_TO_CODE: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: ERROR_CODES.VALIDATION_FAILED,
  [HttpStatus.UNAUTHORIZED]: ERROR_CODES.UNAUTHORIZED,
  [HttpStatus.FORBIDDEN]: ERROR_CODES.FORBIDDEN,
  [HttpStatus.NOT_FOUND]: ERROR_CODES.NOT_FOUND,
  [HttpStatus.CONFLICT]: ERROR_CODES.CONFLICT,
  [HttpStatus.TOO_MANY_REQUESTS]: ERROR_CODES.RATE_LIMITED,
};

/** Приводит любые ошибки к формату `{ code, message, details?, requestId? }`. */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const requestId = req.id !== undefined ? String(req.id) : undefined;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let body: ApiError = { code: ERROR_CODES.INTERNAL, message: 'Внутренняя ошибка сервера' };

    if (exception instanceof AppException) {
      status = exception.getStatus();
      body = { code: exception.code, message: exception.message, details: exception.details };
    } else if (exception instanceof HttpException) {
      status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : String((response as { message?: unknown }).message ?? exception.message);
      body = { code: STATUS_TO_CODE[status] ?? ERROR_CODES.INTERNAL, message };
    } else {
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    }

    if (requestId !== undefined) body.requestId = requestId;
    res.status(status).json(body);
  }
}
