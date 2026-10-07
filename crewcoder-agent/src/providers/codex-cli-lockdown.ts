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

export function codexHostedToolsOnlyArgs(mcpServerNames: readonly string[]): string[] {
  return [
    ...CODEX_NATIVE_TOOL_FEATURES.flatMap((feature) => ["--disable", feature]),
    "-c", "web_search=disabled",
    // Code mode still exposes multi_agent_v1 spawn tools after `--disable multi_agent`.
    "-c", "agents.max_depth=0",
    // `-c mcp_servers={}` merges instead of replacing, so each server is switched off by name.
    ...mcpServerNames.flatMap((name) => ["-c", `mcp_servers.${name}.enabled=false`])
  ];
}

export function parseCodexMcpServerNames(output: string): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(output); } catch { throw new Error("codex mcp list --json returned invalid JSON"); }
  if (!Array.isArray(parsed)) throw new Error("codex mcp list --json did not return a list");
  return parsed.map((entry) => {
    const name = entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
    if (typeof name !== "string" || !MCP_SERVER_NAME.test(name)) throw new Error(`Codex MCP server name ${JSON.stringify(name)} cannot be disabled safely`);
    return name;
  });
}

/**
 * Asks Codex itself which MCP servers it would load for this folder, so global,
 * plugin, and trusted project configs are all covered. Any failure is fatal: the
 * caller must not start Codex with servers it could not disable.
 */
export function listCodexMcpServerNames(command: string, cwd: string): Promise<string[]> {
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
      try { const names = parseCodexMcpServerNames(stdout); settled = true; clearTimeout(timer); resolve(names); }
      catch (error) { fail(error instanceof Error ? error.message : String(error)); }
    });
  });
}
