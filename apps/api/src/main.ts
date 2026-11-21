import 'reflect-metadata';
import { createApp } from './app.factory';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await createApp();
  await app.listen(env.PORT);
}

void bootstrap();
