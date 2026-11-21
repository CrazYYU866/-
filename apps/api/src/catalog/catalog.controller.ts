import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiQuery, ApiTags } from '@nestjs/swagger';
import { ERROR_CODES } from '@kovsh/contracts';
import { z } from 'zod';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CatalogService } from './catalog.service';

const TreeQuery = z.object({
  audience: z.enum(['customer', 'partner']).default('customer'),
  regionId: z.string().uuid().optional(),
});
const PointQuery = z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) });

/** Единый каталог для приложений заказчика и партнёра (без авторизации: каталог можно смотреть до входа). */
@ApiTags('catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('categories')
  @ApiQuery({ name: 'audience', enum: ['customer', 'partner'], required: false })
  @ApiQuery({ name: 'regionId', required: false, description: 'Показать текущую цену часа в регионе' })
  categories(@Query(new ZodValidationPipe(TreeQuery)) q: z.infer<typeof TreeQuery>) {
    return this.catalog.tree(q.audience, q.regionId);
  }

  @Get('categories/:id/attributes')
  attributes(@Param('id', ParseUUIDPipe) id: string) {
    return this.catalog.effectiveAttributes(id);
  }

  @Get('regions')
  regions() {
    return this.catalog.listRegions(true);
  }

  @Get('regions/resolve')
  async resolve(@Query(new ZodValidationPipe(PointQuery)) q: z.infer<typeof PointQuery>) {
    const region = await this.catalog.regionByPoint(q.lat, q.lng);
    if (!region) throw new AppException(ERROR_CODES.REGION_NOT_FOUND, 'По этому адресу сервис пока не работает', HttpStatus.NOT_FOUND);
    return { id: region.id, code: region.code, name: region.name, timezone: region.timezone };
  }
}
