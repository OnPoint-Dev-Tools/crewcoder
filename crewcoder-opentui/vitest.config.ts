import { defineConfig } from "vitest/config";

// OpenTUI's native layer loads through Node's FFI, which Node.js exposes from 26.4.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 26 || (major === 26 && minor < 4)) {
  throw new Error(
    `crewcoder-opentui tests need Node.js >=26.4.0 (current ${process.versions.node}). ` +
    "Run them with a newer runtime, for example: mise exec node@26 -- npm test -w @onpoint-dev-tools/crewcoder-opentui"
  );
}

export default defineConfig({
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "@opentui/react"
  },
  test: {
    pool: "forks",
    testTimeout: 10_000,
    hookTimeout: 10_000
  }
});
