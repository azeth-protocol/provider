import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/examples/**'],
      thresholds: {
        statements: 70,
        lines: 70,
        branches: 60,
        functions: 70,
      },
    },
  },
});
