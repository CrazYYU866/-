import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CreateOrderSchema, ERROR_CODES, OptionalReasonSchema, ReasonSchema, type CreateOrder } from '@kovsh/contracts';
import { CurrentUser, type AuthUser } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { OrdersService } from './orders.service';

const clientOnly = (u: AuthUser) => {
  if (u.app !== 'client') throw new AppException(ERROR_CODES.FORBIDDEN, 'Доступно в приложении заказчика', HttpStatus.FORBIDDEN);
};

@ApiTags('client: заказы')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('client/orders')
export class ClientOrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Post()
  create(@CurrentUser() u: AuthUser, @Body(new ZodValidationPipe(CreateOrderSchema)) dto: CreateOrder) {
    clientOnly(u);
    return this.orders.create(u.userId, dto.quoteId, dto.siteComment, dto.payer);
  }

  @Get()
  list(@CurrentUser() u: AuthUser) {
    clientOnly(u);
    return this.orders.listForCustomer(u.userId);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    clientOnly(u);
    return this.orders.viewForCustomer(u.userId, id);
  }

  @Post(':id/cancel/preview')
  @HttpCode(HttpStatus.OK)
  preview(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    clientOnly(u);
    return this.orders.cancelPreview(u.userId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.NO_CONTENT)
  async cancel(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(OptionalReasonSchema)) dto: { reason?: string }): Promise<void> {
    clientOnly(u);
    await this.orders.cancelByCustomer(u.userId, id, dto.reason);
  }

  @Post(':id/confirm-completion')
  @HttpCode(HttpStatus.NO_CONTENT)
  async confirm(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    clientOnly(u);
    await this.orders.confirmCompletion(u.userId, id);
  }

  @Post(':id/dispute')
  @HttpCode(HttpStatus.NO_CONTENT)
  async dispute(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ReasonSchema)) dto: { reason: string }): Promise<void> {
    clientOnly(u);
    await this.orders.openDispute(u.userId, id, dto.reason);
  }
}
