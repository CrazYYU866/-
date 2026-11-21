import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { APP_ENV } from '../../config/config.module';
import type { AppEnv } from '../../config/env';

/** Шифрование чувствительных полей (реквизиты, секреты 2FA, паспортные данные): AES-256-GCM. */
@Injectable()
export class FieldCipher {
  private readonly key: Buffer;

  constructor(@Inject(APP_ENV) env: AppEnv) {
    this.key = Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
  }

  decrypt(payload: string): string {
    const [version, iv, tag, data] = payload.split(':');
    if (version !== 'v1' || !iv || !tag || !data) throw new Error('Неизвестный формат зашифрованного значения');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
  }
}
