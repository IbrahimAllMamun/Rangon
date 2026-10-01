/** Unit tests run without a database; `test/db/` suites need DATABASE_URL. */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  // parse5 and its `entities` ship ES modules only; the tests run as CommonJS.
  transform: { '^.+\\.(ts|js)$': ['@swc/jest'] },
  transformIgnorePatterns: ['/node_modules/(?!(parse5|entities)/)'],
  moduleFileExtensions: ['ts', 'js', 'json'],
};
