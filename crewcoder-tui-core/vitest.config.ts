import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
