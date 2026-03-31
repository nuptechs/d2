import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/__tests__/**/*.test.ts', 'server/**/__tests__/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/*/src/**/*.ts', 'server/src/**/*.ts'],
      exclude: ['**/dist/**', '**/*.d.ts', '**/index.ts'],
    },
    testTimeout: 10000,
  },
});
