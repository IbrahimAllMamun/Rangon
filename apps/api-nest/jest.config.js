/** Unit tests run without a database; `test/db/` suites need DATABASE_URL. */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['@swc/jest'] },
  moduleFileExtensions: ['ts', 'js', 'json'],
};
