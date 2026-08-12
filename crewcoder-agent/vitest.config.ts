import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    setupFiles: ['./src/tests/test-home-setup.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
