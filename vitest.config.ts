import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@daypi/platform/db': path.resolve(__dirname, 'platform/db/src/index.ts'),
      '@daypi/platform/config': path.resolve(__dirname, 'platform/config/src/index.ts'),
      '@daypi/platform/auth': path.resolve(__dirname, 'platform/auth/src/index.ts'),
      '@daypi/platform/tenancy': path.resolve(__dirname, 'platform/tenancy/src/index.ts'),
      '@daypi/platform/audit': path.resolve(__dirname, 'platform/audit/src/index.ts'),
      '@daypi/platform/jobs': path.resolve(__dirname, 'platform/jobs/src/index.ts'),
      '@daypi/platform/storage': path.resolve(__dirname, 'platform/storage/src/index.ts'),
      '@daypi/platform/authz': path.resolve(__dirname, 'platform/authz/src/index.ts'),
      '@daypi/platform/http': path.resolve(__dirname, 'platform/http/src/index.ts'),
    },
  },
});
