import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AdminAuthService } from './admin-auth.service';

/** Создание первого суперадминистратора: node dist/admin/create-admin.cli.js email "ФИО" пароль */
async function main(): Promise<void> {
  const [email, fullName, password] = process.argv.slice(2);
  if (!email || !fullName || !password || password.length < 12) {
    console.error('Использование: create-admin <email> <ФИО> <пароль не короче 12 символов>');
    process.exit(1);
  }
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const admin = await app.get(AdminAuthService).createAdmin({ email, fullName, password, role: 'superadmin' }, null);
    console.log(`Создан суперадминистратор ${admin.email}`);
  } finally {
    await app.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
