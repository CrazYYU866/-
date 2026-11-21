/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json', diagnostics: { ignoreCodes: [151002] } }] },
  moduleNameMapper: { '^@kovsh/contracts$': '<rootDir>/../../packages/contracts/src' },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
};
