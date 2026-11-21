import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ERROR_CODES, type MeResponse, type RegisterPushDevice } from '@kovsh/contracts';
import { and, eq, sql } from 'drizzle-orm';
import { AppException } from '../common/app-exception';
import { DB, type Database } from '../database/database.module';
import { pushDevices, users } from '../database/schema';

export type UserRow = typeof users.$inferSelect;

export function toMe(u: UserRow): MeResponse {
  return { id: u.id, phone: u.phone, fullName: u.fullName, status: u.status, createdAt: u.createdAt.toISOString() };
}

@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Находит пользователя по телефону или создаёт нового. Безопасно при параллельных вызовах. */
  async findOrCreateByPhone(phone: string): Promise<{ user: UserRow; isNew: boolean }> {
    const inserted = await this.db.insert(users).values({ phone }).onConflictDoNothing().returning();
    if (inserted[0]) return { user: inserted[0], isNew: true };
    const [existing] = await this.db.select().from(users).where(eq(users.phone, phone));
    if (!existing) throw new Error('Пользователь не найден после вставки');
    return { user: existing, isNew: false };
  }

  async getById(id: string): Promise<UserRow> {
    const [u] = await this.db.select().from(users).where(eq(users.id, id));
    if (!u) throw new AppException(ERROR_CODES.NOT_FOUND, 'Пользователь не найден', HttpStatus.NOT_FOUND);
    return u;
  }

  async updateProfile(id: string, fullName: string): Promise<UserRow> {
    const [u] = await this.db.update(users).set({ fullName }).where(eq(users.id, id)).returning();
    if (!u) throw new AppException(ERROR_CODES.NOT_FOUND, 'Пользователь не найден', HttpStatus.NOT_FOUND);
    return u;
  }

  /** Токен устройства принадлежит последнему вошедшему пользователю. */
  async registerPushDevice(userId: string, app: 'client' | 'partner', dto: RegisterPushDevice): Promise<void> {
    await this.db
      .insert(pushDevices)
      .values({ userId, app, platform: dto.platform, token: dto.token })
      .onConflictDoUpdate({
        target: pushDevices.token,
        set: { userId, app, platform: dto.platform, active: true, updatedAt: sql`now()` },
      });
  }

  async removePushDevice(userId: string, token: string): Promise<void> {
    await this.db
      .update(pushDevices)
      .set({ active: false })
      .where(and(eq(pushDevices.userId, userId), eq(pushDevices.token, token)));
  }
}
