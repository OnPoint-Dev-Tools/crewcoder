import { spawn } from "node:child_process";

/**
 * Native Codex features that act on the filesystem, shell, network, other agents,
 * or user-configured commands outside CrewCoder's dynamic tools. Codex refuses to
 * start on an unknown feature name, so a renamed flag fails closed.
 */
export const CODEX_NATIVE_TOOL_FEATURES = [
  "shell_tool", "unified_exec", "view_image", "browser_use", "computer_use", "apps", "plugins",
  "multi_agent", "image_generation", "sleep_tool", "goals", "tool_suggest", "skill_search",
  // User hooks run shell commands on session and tool events.
  "hooks"
  // Code mode stays on: code_mode_only models (gpt-5.6, gpt-6) reach dynamic tools only
  // through it, and its runtime has no require, process, fetch, or import.
] as const;

const MCP_LIST_TIMEOUT_MS = 20_000;
const MCP_LIST_OUTPUT_LIMIT = 256_000;
// Bare TOML keys only, so a server name can never inject other `-c` overrides.
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]{1,128}$/;

export type CodexMcpServer = { name: string; transport: "stdio" | "http" };

export function codexHostedToolsOnlyArgs(mcpServers: readonly CodexMcpServer[]): string[] {
  for (const { name, transport } of mcpServers) {
    if (!MCP_SERVER_NAME.test(name)) throw new Error(`Codex MCP server name ${JSON.stringify(name)} cannot be disabled safely`);
    if (transport !== "stdio" && transport !== "http") throw new Error(`Invalid Codex MCP transport for ${name}`);
  }
  // Plugin-discovered entries may have no transport in user config. Overriding
  // only enabled can create incomplete entries and break app-server config
  // decoding. Supply complete, inert entries in one process-only table instead.
  // Codex merges overrides into existing entries. A stdio command on an HTTP
  // entry retains its URL and fails config parsing, even when disabled.
  const disabledServers = mcpServers.map(({ name, transport }) => `${name}={${transport === "http"
    ? 'url="http://127.0.0.1:9"'
    : `command=${JSON.stringify(process.execPath)}`},enabled=false}`).join(",");
  return [
    ...CODEX_NATIVE_TOOL_FEATURES.flatMap((feature) => ["--disable", feature]),
    "-c", "web_search=disabled",
    // Code mode still exposes multi_agent_v1 spawn tools after `--disable multi_agent`.
    "-c", "agents.max_depth=0",
    // An empty table does not clear inherited servers: enumerate every discovered name.
    ...(mcpServers.length ? ["-c", `mcp_servers={${disabledServers}}`] : [])
  ];
}

export function parseCodexMcpServers(output: string): CodexMcpServer[] {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error("codex mcp list --json returned invalid JSON"); }
  if (!Array.isArray(parsed)) throw new Error("codex mcp list --json did not return a list");
  return parsed.map((entry) => {
    const name = entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
    if (typeof name !== "string" || !MCP_SERVER_NAME.test(name)) throw new Error(`Codex MCP server name ${JSON.stringify(name)} cannot be disabled safely`);
    const row = entry as Record<string, unknown>;
    const transport = row.transport;
    // Plugin-discovered names can omit transport fields; the disabled stdio
    // placeholder supplies the complete entry those configs still require.
    if (transport == null && row.url == null && row.command == null) return { name, transport: "stdio" };
    if (!transport || typeof transport !== "object" || Array.isArray(transport)) throw new Error(`Invalid Codex MCP transport for ${name}`);
    const details = transport as Record<string, unknown>;
    if (details.type === "stdio" && details.url == null) return { name, transport: "stdio" };
    if (details.type === "streamable_http" && details.command == null) return { name, transport: "http" };
    throw new Error(`Invalid or ambiguous Codex MCP transport for ${name}`);
  });
}

/**
 * Asks Codex itself which MCP servers it would load for this folder, so global,
 * plugin, and trusted project configs are all covered. Any failure is fatal: the
 * caller must not start Codex with servers it could not disable.
 */
export function listCodexMcpServers(command: string, cwd: string): Promise<CodexMcpServer[]> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let settled = false;
    const fail = (message: string) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(message)); } };
    const child = spawn(command, ["mcp", "list", "--json"], { cwd, shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => { child.kill("SIGTERM"); fail("codex mcp list --json timed out"); }, MCP_LIST_TIMEOUT_MS);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.length > MCP_LIST_OUTPUT_LIMIT) { child.kill("SIGTERM"); fail("codex mcp list --json output is too large"); }
    });
    child.once("error", (error) => fail(`codex mcp list --json failed: ${error.message}`));
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) { fail(`codex mcp list --json exited with ${code}`); return; }
      try { const names = parseCodexMcpServers(stdout); settled = true; clearTimeout(timer); resolve(names); }
      catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });
  });
}
