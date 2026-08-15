import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: 'test/globalSetup.ts',
    exclude: [...configDefaults.exclude, 'web/**', 'e2e/**'],
    // Suites share one test database; run files sequentially.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
