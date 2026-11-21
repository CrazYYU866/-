import { Body, Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ERROR_CODES, QuoteRequestSchema, type QuoteRequest, type QuoteResponse } from '@kovsh/contracts';
import { CurrentUser, type AuthUser } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PricingService } from './pricing.service';

@ApiTags('client: расчёт стоимости')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('client/quotes')
export class ClientQuotesController {
  constructor(private readonly pricing: PricingService) {}

  @Post()
  quote(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(QuoteRequestSchema)) dto: QuoteRequest): Promise<QuoteResponse> {
    if (user.app !== 'client') throw new AppException(ERROR_CODES.FORBIDDEN, 'Доступно в приложении заказчика', HttpStatus.FORBIDDEN);
    return this.pricing.quote(user.userId, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.pricing.getQuote(user.userId, id);
  }
}
