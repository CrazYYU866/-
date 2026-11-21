process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://kovsh:kovsh@localhost:5432/kovsh_test';
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/15';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-test-access-secret-0001';
process.env.OTP_HASH_SECRET = 'test-otp-secret-test-otp-secret-test-0001';
process.env.SMS_PROVIDER = 'dev';
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.ADMIN_JWT_SECRET = 'test-admin-secret-test-admin-secret-0001';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = require('node:path').join(require('node:os').tmpdir(), 'kovsh-test-storage');
