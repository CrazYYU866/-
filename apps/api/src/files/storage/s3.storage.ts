import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { StorageProvider } from './storage.provider';

export class S3Storage implements StorageProvider {
  private readonly client: S3Client;
  constructor(
    private readonly bucket: string,
    opts: { endpoint?: string | undefined; region: string; accessKeyId: string; secretAccessKey: string },
  ) {
    this.client = new S3Client({
      region: opts.region,
      ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
      forcePathStyle: true,
    });
  }
  async put(key: string, body: Buffer, mime: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: mime, ServerSideEncryption: 'AES256' }),
    );
  }
  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error('Пустой объект');
    return Buffer.from(await res.Body.transformToByteArray());
  }
}
