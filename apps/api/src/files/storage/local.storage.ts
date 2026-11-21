import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { StorageProvider } from './storage.provider';

export class LocalStorage implements StorageProvider {
  private readonly root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }
  private path(key: string): string {
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root)) throw new Error('Недопустимый ключ файла');
    return p;
  }
  async put(key: string, body: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, body);
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
}
