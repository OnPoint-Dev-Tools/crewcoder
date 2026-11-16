import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [...configDefaults.include, "../test/claude-context-usage.test.ts"],
    pool: 'forks',
    setupFiles: ['./src/tests/test-home-setup.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
