import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { StorageProvider } from './storage.provider';

export class S3Storage implements StorageProvider {
  private readonly client: S3Client;
  private readonly sse: 'AES256' | 'aws:kms' | undefined;
  constructor(
    private readonly bucket: string,
    opts: { endpoint?: string | undefined; region: string; accessKeyId: string; secretAccessKey: string; serverSideEncryption?: 'AES256' | 'aws:kms' | undefined },
  ) {
    // Шифрование «на месте»: в Yandex Object Storage — ключом KMS, заданным для бакета по умолчанию;
    // заголовок в запросе передаём только если он явно задан (S3_SERVER_SIDE_ENCRYPTION).
    this.sse = opts.serverSideEncryption;
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      forcePathStyle: true,
    });
  }
  async put(key: string, body: Buffer, mime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime, ...(this.sse ? { ServerSideEncryption: this.sse } : {}) }),
    );
  }
  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error('Пустой объект');
    return Buffer.from(await res.Body.transformToByteArray());
  }
}
