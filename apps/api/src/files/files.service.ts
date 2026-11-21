import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES } from '@kovsh/contracts';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { AppException } from '../common/app-exception';
import { DB, type Database } from '../database/database.module';
import { documents, files, organizationMembers } from '../database/schema';
import { STORAGE, type StorageProvider } from './storage/storage.provider';

export const MAX_FILE_BYTES = 15 * 1024 * 1024;

/** Разрешённые типы и их сигнатуры (первые байты файла), чтобы тип нельзя было подделать расширением. */
const ALLOWED: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP',
  'image/heic': (b) => b.subarray(4, 8).toString() === 'ftyp',
  'application/pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
};

export type FileRow = typeof files.$inferSelect;

@Injectable()
export class FilesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(STORAGE) private readonly storage: StorageProvider,
  ) {}

  async upload(
    body: Buffer,
    mime: string,
    originalName: string | undefined,
    by: { userId?: string; adminId?: string },
  ): Promise<FileRow> {
    if (body.length === 0 || body.length > MAX_FILE_BYTES) {
      throw new AppException(ERROR_CODES.FILE_TOO_LARGE, 'Файл пустой или больше 15 МБ', HttpStatus.PAYLOAD_TOO_LARGE);
    }
    const check = ALLOWED[mime];
    if (!check || !check(body)) {
      throw new AppException(
        ERROR_CODES.FILE_TYPE_NOT_ALLOWED,
        'Допустимы JPEG, PNG, WEBP, HEIC и PDF',
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      );
    }
    const id = randomUUID();
    const key = `${new Date().toISOString().slice(0, 7)}/${id}`;
    await this.storage.put(key, body, mime);
    const [row] = await this.db
      .insert(files)
      .values({
        id,
        storageKey: key,
        mime,
        sizeBytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        originalName: originalName?.slice(0, 255) ?? null,
        uploadedByUserId: by.userId ?? null,
        uploadedByAdminId: by.adminId ?? null,
      })
      .returning();
    if (!row) throw new Error('Не удалось сохранить файл');
    return row;
  }

  async getMeta(id: string): Promise<FileRow> {
    const [row] = await this.db.select().from(files).where(eq(files.id, id));
    if (!row) throw new AppException(ERROR_CODES.NOT_FOUND, 'Файл не найден', HttpStatus.NOT_FOUND);
    return row;
  }

  async read(id: string): Promise<{ meta: FileRow; body: Buffer }> {
    const meta = await this.getMeta(id);
    return { meta, body: await this.storage.get(meta.storageKey) };
  }

  /**
   * Может ли пользователь читать файл: загрузил сам, либо файл — документ его организации
   * (видят главный владелец и руководители) или его собственный документ машиниста.
   */
  async canUserRead(userId: string, file: FileRow): Promise<boolean> {
    if (file.uploadedByUserId === userId) return true;
    const docs = await this.db
      .select({ ownerType: documents.ownerType, ownerId: documents.ownerId })
      .from(documents)
      .where(eq(documents.fileId, file.id));
    for (const d of docs) {
      if (d.ownerType === 'organization') {
        const [m] = await this.db
          .select({ id: organizationMembers.id })
          .from(organizationMembers)
          .where(
            and(
              eq(organizationMembers.orgId, d.ownerId),
              eq(organizationMembers.userId, userId),
              eq(organizationMembers.status, 'active'),
              inArray(organizationMembers.role, ['owner', 'manager']),
            ),
          );
        if (m) return true;
      }
      if (d.ownerType === 'operator') {
        const [m] = await this.db.execute<{ ok: boolean }>(sql`
          SELECT true AS ok FROM organization_members op
          WHERE op.id = ${d.ownerId} AND (
            op.user_id = ${userId} OR EXISTS (
              SELECT 1 FROM organization_members mgr
              WHERE mgr.org_id = op.org_id AND mgr.user_id = ${userId}
                AND mgr.status = 'active' AND mgr.role IN ('owner', 'manager')))`).then((r) => r.rows);
        if (m) return true;
      }
    }
    return false;
  }

  /** Файл должен быть загружен этим пользователем и ещё не привязан к другому документу. */
  async assertOwnedUnused(userId: string, fileId: string): Promise<void> {
    const file = await this.getMeta(fileId);
    if (file.uploadedByUserId !== userId) {
      throw new AppException(ERROR_CODES.FORBIDDEN, 'Файл загружен другим пользователем', HttpStatus.FORBIDDEN);
    }
    const [used] = await this.db
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.fileId, fileId), isNull(documents.supersededAt)));
    if (used) throw new AppException(ERROR_CODES.CONFLICT, 'Файл уже привязан к документу', HttpStatus.CONFLICT);
  }
}
