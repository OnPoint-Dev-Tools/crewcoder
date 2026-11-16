import { describe, expect, it } from "vitest";
import { codexHostedToolsOnlyArgs } from "../crewcoder-agent/src/providers/codex-cli-lockdown.js";

describe("Codex disabled MCP transport overrides", () => {
  it("provides complete disabled transports for user and plugin-discovered entries", () => {
    const names = ["blender", "codex_app", "cua_repl", "node_repl", "rea"];
    const args = codexHostedToolsOnlyArgs(names.map(name => ({ name, transport: "stdio" })));
    const tables = args.filter(arg => arg.startsWith("mcp_servers="));
    expect(tables).toEqual([`mcp_servers={${names.map(name => `${name}={command=${JSON.stringify(process.execPath)},enabled=false}`).join(",")}}`]);
    expect(args.some(arg => /^mcp_servers\..*\.enabled=/.test(arg))).toBe(false);
    expect(args).toContain("plugins");
    expect(args).toContain("shell_tool");
  });

  it("does not insert an empty table or accept override injection", () => {
    expect(codexHostedToolsOnlyArgs([]).some(arg => arg.startsWith("mcp_servers="))).toBe(false);
    expect(() => codexHostedToolsOnlyArgs([{ name: "bad,enabled=true", transport: "stdio" }])).toThrow("cannot be disabled safely");
  });

  it("keeps HTTP entries disabled without adding an incompatible stdio transport", () => {
    const args = codexHostedToolsOnlyArgs([
      { name: "openaiDeveloperDocs", transport: "http" }, { name: "node_repl", transport: "stdio" },
    ]);
    expect(args).toContain(`mcp_servers={openaiDeveloperDocs={url="http://127.0.0.1:9",enabled=false},node_repl={command=${JSON.stringify(process.execPath)},enabled=false}}`);
  });
});
