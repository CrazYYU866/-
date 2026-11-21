process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://kovsh:kovsh@localhost:5432/kovsh_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
