import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, type DocumentOwnerType, type LegalForm, type UploadDocument } from '@kovsh/contracts';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import { DB, type Database } from '../database/database.module';
import { documents, documentTypes } from '../database/schema';
import { FilesService } from '../files/files.service';

export interface DocumentView {
  id: string;
  typeCode: string;
  typeTitle: string;
  fileId: string;
  status: string;
  reviewComment: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface RequirementView {
  code: string;
  title: string;
  required: boolean;
  status: 'missing' | 'uploaded' | 'approved' | 'rejected' | 'expired';
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly files: FilesService,
  ) {}

  async typesFor(ownerType: DocumentOwnerType, legalForm?: LegalForm) {
    const rows = await this.db
      .select()
      .from(documentTypes)
      .where(and(eq(documentTypes.appliesTo, ownerType), eq(documentTypes.active, true)))
      .orderBy(asc(documentTypes.sort));
    return rows.filter((t) => !t.legalForms || !legalForm || t.legalForms.includes(legalForm));
  }

  async list(ownerType: DocumentOwnerType, ownerId: string): Promise<DocumentView[]> {
    const rows = await this.db
      .select({ d: documents, t: documentTypes })
      .from(documents)
      .innerJoin(documentTypes, eq(documentTypes.id, documents.documentTypeId))
      .where(and(eq(documents.ownerType, ownerType), eq(documents.ownerId, ownerId), isNull(documents.supersededAt)))
      .orderBy(asc(documentTypes.sort), desc(documents.createdAt));
    return rows.map(({ d, t }) => ({
      id: d.id,
      typeCode: t.code,
      typeTitle: t.title,
      fileId: d.fileId,
      status: d.status,
      reviewComment: d.reviewComment,
      expiresAt: d.expiresAt,
      createdAt: d.createdAt.toISOString(),
    }));
  }

  /** Сводка по обязательным и необязательным документам владельца. */
  async requirements(ownerType: DocumentOwnerType, ownerId: string, legalForm?: LegalForm): Promise<RequirementView[]> {
    const [types, docs] = await Promise.all([this.typesFor(ownerType, legalForm), this.list(ownerType, ownerId)]);
    return types.map((t) => {
      const doc = docs.find((d) => d.typeCode === t.code);
      return { code: t.code, title: t.title, required: t.required, status: (doc?.status ?? 'missing') as RequirementView['status'] };
    });
  }

  /** Загрузка документа. Предыдущая версия того же типа помечается заменённой, история сохраняется. */
  async upload(
    ownerType: DocumentOwnerType,
    ownerId: string,
    dto: UploadDocument,
    userId: string,
    legalForm?: LegalForm,
  ): Promise<DocumentView> {
    const type = (await this.typesFor(ownerType, legalForm)).find((t) => t.code === dto.documentTypeCode);
    if (!type) {
      throw new AppException(ERROR_CODES.VALIDATION_FAILED, 'Такой тип документа здесь не используется', HttpStatus.BAD_REQUEST);
    }
    await this.files.assertOwnedUnused(userId, dto.fileId);
    await this.db.transaction(async (tx) => {
      await tx
        .update(documents)
        .set({ supersededAt: new Date() })
        .where(
          and(
            eq(documents.ownerType, ownerType),
            eq(documents.ownerId, ownerId),
            eq(documents.documentTypeId, type.id),
            isNull(documents.supersededAt),
          ),
        );
      await tx.insert(documents).values({
        ownerType,
        ownerId,
        documentTypeId: type.id,
        fileId: dto.fileId,
        uploadedBy: userId,
        expiresAt: dto.expiresAt ?? null,
      });
    });
    const view = (await this.list(ownerType, ownerId)).find((d) => d.typeCode === type.code);
    if (!view) throw new Error('Документ не сохранён');
    return view;
  }

  async getById(id: string) {
    const [row] = await this.db
      .select({ d: documents, t: documentTypes })
      .from(documents)
      .innerJoin(documentTypes, eq(documentTypes.id, documents.documentTypeId))
      .where(eq(documents.id, id));
    if (!row) throw new AppException(ERROR_CODES.NOT_FOUND, 'Документ не найден', HttpStatus.NOT_FOUND);
    return row;
  }
}
