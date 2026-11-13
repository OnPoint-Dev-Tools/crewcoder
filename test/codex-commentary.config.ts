import { defineConfig } from "vitest/config";

export default defineConfig({ test: {
  include: ["test/codex-commentary.test.ts", "test/codex-public-progress.test.ts", "test/codex-progress-boundaries.test.ts"],
  setupFiles: ["./crewcoder-agent/src/tests/test-home-setup.ts"],
  testTimeout: 10_000
} });
