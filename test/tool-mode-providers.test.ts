import * as childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCodexCliProvider } from "../crewcoder-agent/src/providers/codex-app-server-provider.js";
import { runClaudeAgentSdkProvider } from "../crewcoder-agent/src/providers/claude-agent-sdk-provider.js";
import type { ProviderDefinition, ProviderRunInput } from "../crewcoder-agent/src/providers/types.js";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof childProcess>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
const queryMock = vi.hoisted(() => vi.fn());
vi.mock("../crewcoder-agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs", () => ({
  query: queryMock, tool: vi.fn(), createSdkMcpServer: vi.fn()
}));
const codex: ProviderDefinition = { id: "codex-cli", title: "Codex", kind: "builtin", runtime: "openai-codex-responses", command: "codex", args: [] };
const claude: ProviderDefinition = { ...codex, id: "claude", runtime: "claude-agent-sdk" };
afterEach(() => vi.restoreAllMocks());
beforeEach(() => {
  queryMock.mockReset();
  queryMock.mockReturnValue({ async *[Symbol.asyncIterator]() { yield { type: "result", subtype: "success", result: "done" }; } });
});

describe("Codex tool-mode launch boundary", () => {
  it.each([
    { toolMode: "crewcoder" as const, virtual: false, locked: true },
    { toolMode: "native" as const, virtual: false, locked: false },
    { toolMode: "native" as const, virtual: true, locked: true }
  ].flatMap(policy => (["never", "review", "always", "full-access", "sandboxed"] as const).map(approvalMode => ({ ...policy, approvalMode }))))("launches with the selected policy: %j", async ({toolMode, virtual, locked, approvalMode}) => {
    fs.mkdirSync(process.env.CREWCODER_HOME!, { recursive: true });
    const root = fs.mkdtempSync(path.join(process.env.CREWCODER_HOME!, "wire-"));
    const fixture = path.join(root, "codex.cjs");
    const log = path.join(root, "wire.jsonl");
    fs.writeFileSync(fixture, `
const fs = require("node:fs"), readline = require("node:readline");
const log = ${JSON.stringify(log)};
if (process.argv.includes("mcp")) { process.stdout.write('[{"name":"configured"}]'); process.exit(0); }
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
readline.createInterface({input: process.stdin}).on("line", line => {
 const m = JSON.parse(line); fs.appendFileSync(log, line + "\\n");
 if (m.method === "initialize") send({ id: m.id, result: {} });
 if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "test-thread" } } });
 if (m.method === "turn/start") { send({id:m.id,result:{}}); send({id:900,method:"item/fileChange/requestApproval",params:{reason:"native write"}}); }
 if (m.id === 900) { send({method:"item/agentMessage/delta",params:{delta:"done"}});send({method:"turn/completed",params:{turn:{status:"completed"}}}); }
});
`);
    const launches: string[][] = [];
    const { spawn } = await vi.importActual<typeof childProcess>("node:child_process");
    vi.mocked(childProcess.spawn).mockImplementation(((command, args, options) => {
      launches.push(args);
      return spawn(process.execPath, [fixture, ...args], options);
    }) as typeof childProcess.spawn);
    const requestQuestion = vi.fn(async () => "accept");
    const result = await runCodexCliProvider({
      provider: codex, cwd: root, prompt: "hi",
      modelInput: { systemPrompt: "", messages: [], availableTools: [], toolMode, useProviderNativeFileTools: !virtual, approvalMode },
      stream: { requestQuestion }
    });
    expect(result.exitCode).toBe(0);
    const records = fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const thread = records.find(r => r.method === "thread/start").params;
    expect(thread.sandbox).toBe(locked ? "read-only" : approvalMode === "full-access" ? "danger-full-access" : "workspace-write");
    if (locked) {
      expect(thread.developerInstructions).toContain("describe Codex native tools only");
      expect(thread.developerInstructions).toContain("Workspace editing is available under every CrewCoder approval policy");
      expect(thread.developerInstructions).toContain("await tools.edit(...)");
      expect(thread.developerInstructions).toContain("Respect actual tool denials");
    } else expect(thread.developerInstructions).toBe("");
    expect(records.find(r => r.id === 900).result.decision).toBe(locked ? "decline" : "accept");
    expect(requestQuestion).toHaveBeenCalledTimes(locked || approvalMode === "full-access" ? 0 : 1);
    expect(launches.flat().includes("--disable")).toBe(locked);
    expect(launches.flat().includes(`mcp_servers={configured={command=${JSON.stringify(process.execPath)},enabled=false}}`)).toBe(locked);
  });
});

describe("Claude tool mode", () => {
  const request = (toolMode: "native" | "crewcoder", approvalMode: "review" | "never" | "full-access" | "sandboxed" = "review"): ProviderRunInput => ({
    provider: claude, cwd: process.env.CREWCODER_HOME!, prompt: "hi",
    modelInput: { systemPrompt: "", messages: [], availableTools: [], toolMode, approvalMode },
    stream: { executeTool: vi.fn(), requestQuestion: vi.fn(async () => "allow") }
  });

  it("disables native file tools in CrewCoder mode", async () => {
    await runClaudeAgentSdkProvider(request("crewcoder"));
    expect(queryMock.mock.calls[0][0].options.tools).toEqual(["AskUserQuestion"]);
    expect(await queryMock.mock.calls[0][0].options.canUseTool("Bash", {})).toMatchObject({behavior:"deny"});
  });

  it("enables the SDK native preset with explicit review and denial", async () => {
    const input = request("native");
    await runClaudeAgentSdkProvider(input);
    const options = queryMock.mock.calls[0][0].options;
    expect(options.tools).toEqual({type:"preset",preset:"claude_code"});
    expect(options.strictMcpConfig).toBe(true);
    expect(await options.canUseTool("Bash", {command:"echo marker"})).toMatchObject({behavior:"allow"});
    expect(input.stream!.requestQuestion).toHaveBeenCalledWith(expect.objectContaining({kind:"permission"}));
    vi.mocked(input.stream!.requestQuestion!).mockResolvedValue(undefined);
    expect(await options.canUseTool("Bash", {command:"echo marker"})).toMatchObject({behavior:"deny"});
  });

  it("never prompts in Never mode and preserves Full access", async () => {
    for (const mode of ["never", "full-access"] as const) {
      const input = request("native", mode);
      await runClaudeAgentSdkProvider(input);
      const callback = queryMock.mock.calls.at(-1)[0].options.canUseTool;
      expect(await callback("Edit", {})).toMatchObject({behavior:mode === "never" ? "deny" : "allow"});
      expect(input.stream!.requestQuestion).not.toHaveBeenCalled();
    }
  });

  it("host file custody overrides native mode even at the adapter boundary", async () => {
    const input = request("native");
    input.modelInput!.useProviderNativeFileTools = false;
    await runClaudeAgentSdkProvider(input);
    expect(queryMock.mock.calls[0][0].options.tools).toEqual(["AskUserQuestion"]);
  });

  it("refuses to claim OS sandboxing for Claude native tools", async () => {
    await expect(runClaudeAgentSdkProvider(request("native", "sandboxed"))).rejects.toThrow("OS sandbox");
    expect(queryMock).not.toHaveBeenCalled();
  });
});
