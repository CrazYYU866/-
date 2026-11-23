import { Controller, Get, Inject, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { GEOCODER, type GeocoderProvider } from './geocoder.provider';

const SuggestQuery = z.object({ q: z.string().trim().min(2).max(200) });
const ReverseQuery = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) });

/** Подсказки адреса для приложений (через сервер — ключ провайдера не попадает в приложение). */
@ApiTags('geo')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('geo')
export class GeoController {
  constructor(@Inject(GEOCODER) private readonly geocoder: GeocoderProvider) {}

  @Get('suggest')
  async suggest(@Query(new ZodValidationPipe(SuggestQuery)) q: z.infer<typeof SuggestQuery>) {
    return { provider: this.geocoder.name, items: await this.geocoder.suggest(q.q) };
  }

  @Get('reverse')
  async reverse(@Query(new ZodValidationPipe(ReverseQuery)) q: z.infer<typeof ReverseQuery>) {
    return { provider: this.geocoder.name, item: await this.geocoder.reverse(q) };
  }
}
