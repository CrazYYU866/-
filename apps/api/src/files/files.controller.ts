import {
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { ERROR_CODES } from '@kovsh/contracts';
import type { Response } from 'express';
import { CurrentUser, type AuthUser } from '../auth/current-user';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AppException } from '../common/app-exception';
import { FilesService, MAX_FILE_BYTES } from './files.service';

export interface FileResponse {
  id: string;
  mime: string;
  sizeBytes: number;
  originalName: string | null;
}

@ApiTags('files')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES + 1 } }))
  async upload(@CurrentUser() user: AuthUser, @UploadedFile() file?: Express.Multer.File): Promise<FileResponse> {
    if (!file) throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Передайте файл в поле file', HttpStatus.BAD_REQUEST);
    const row = await this.files.upload(file.buffer, file.mimetype, file.originalname, { userId: user.userId });
    return { id: row.id, mime: row.mime, sizeBytes: row.sizeBytes, originalName: row.originalName };
  }

  @Get(':id/content')
  async content(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ): Promise<void> {
    const meta = await this.files.getMeta(id);
    if (!(await this.files.canUserRead(user.userId, meta))) {
      throw new AppException(ERROR_CODES.NOT_FOUND, 'Файл не найден', HttpStatus.NOT_FOUND);
    }
    const { body } = await this.files.read(id);
    res.setHeader('Content-Type', meta.mime);
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(body);
  }
}
