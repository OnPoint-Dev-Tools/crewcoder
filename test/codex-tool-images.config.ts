import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["test/codex-tool-images.test.ts"],
  setupFiles: ["./crewcoder-agent/src/tests/test-home-setup.ts"],
  testTimeout: 10_000
} });

