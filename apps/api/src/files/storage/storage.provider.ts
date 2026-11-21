/** Хранилище файлов. Прод: Yandex Object Storage через S3 API (В-37); разработка: локальный диск. */
export interface StorageProvider {
  put(key: string, body: Buffer, mime: string): Promise<void>;
  get(key: string): Promise<Buffer>;
}
export const STORAGE = Symbol('STORAGE');
