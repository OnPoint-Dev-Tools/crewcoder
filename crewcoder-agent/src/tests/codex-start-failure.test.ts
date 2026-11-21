import { describe, expect, it } from "vitest";
import { codexCliStartFailure } from "../providers/codex-app-server-provider.js";

describe("codexCliStartFailure", () => {
  it("keeps the crash's first error line, not only its stack tail", () => {
    const stderr = [
      "node:internal/modules/cjs/loader:1228",
      "  throw err;",
      "  ^",
      "",
      "Error: Cannot find module '/tmp/crew-question-abc/app-server'",
      "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)",
      "  code: 'MODULE_NOT_FOUND',",
      "  requireStack: []",
      "}",
      "",
      "Node.js v22.23.5"
    ].join("\n");
    const message = codexCliStartFailure("/usr/bin/node", { message: "Codex app-server closed before responding", stderr });
    expect(message).toContain("Error: Cannot find module '/tmp/crew-question-abc/app-server'");
    expect(message).toContain("Node.js v22.23.5");
    expect(message.startsWith("Codex CLI app-server could not start (Codex app-server closed before responding; ")).toBe(true);
  });

  it("reports a missing executable plainly and keeps short stderr as is", () => {
    expect(codexCliStartFailure("codex", { message: "spawn codex ENOENT", code: "ENOENT", stderr: "" })).toContain("Codex CLI was not found");
    expect(codexCliStartFailure("codex", { message: "exit 1", stderr: "not logged in" })).toContain("(exit 1; not logged in)");
  });
});
