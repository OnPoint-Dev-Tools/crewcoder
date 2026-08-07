import { describe, expect, it } from "vitest";
import { bashTool } from "../tools/bash.js";
import type { ToolContext } from "../core/tool-types.js";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return { cwd: process.cwd(), mode: "general", sessionId: "s1", mutationLog: [], ...overrides };
}

describe("bash sandbox tier", () => {
  it("runs normally without a sandbox policy", async () => {
    const result = await bashTool.execute({ command: "echo hi", timeoutMs: 5000 }, context());
    expect(result.content[0]?.text).toContain("hi");
    expect(result.details?.sandboxed).toBe(false);
  });

  it("fails closed when a sandbox is required but no backend is available", async () => {
    const ctx = context({ sandbox: { policy: { enabled: true, workspaceDir: process.cwd(), network: { mode: "none", allowedHosts: [] } }, backend: "none" } });
    await expect(bashTool.execute({ command: "echo hi", timeoutMs: 5000 }, ctx)).rejects.toThrow(/requires a sandbox backend/i);
  });
});
