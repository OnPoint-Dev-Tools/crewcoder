import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { textMessage, type ToolCallPart } from "../core/messages.js";
import { builtinProviders } from "../providers/builtins.js";
import { enableCodexAppServerPooling, isCodexCliProvider, runCodexCliProvider } from "../providers/codex-app-server-provider.js";
import { CODEX_NATIVE_TOOL_FEATURES, codexHostedToolsOnlyArgs, parseCodexMcpServerNames } from "../providers/codex-cli-lockdown.js";
import type { ProviderDefinition } from "../providers/types.js";

const originalHome = process.env.CREWCODER_HOME;
const originalCodexPath = process.env.CREWCODER_CODEX_PATH;
const originalCodexHome = process.env.CODEX_HOME;
const provider = builtinProviders.find((item) => item.id === "codex-cli") as ProviderDefinition;

afterEach(() => {
  enableCodexAppServerPooling(false);
  restore("CREWCODER_HOME", originalHome);
  restore("CREWCODER_CODEX_PATH", originalCodexPath);
  restore("CODEX_HOME", originalCodexHome);
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}

function writeFakeCodex(dir: string, log: string, mcpList = '[{"name":"node_repl","enabled":true},{"name":"computer-use","enabled":true}]'): string {
  const server = path.join(dir, "fake-codex.cjs");
  fs.writeFileSync(server, `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
const log=${JSON.stringify(log)};
if(process.argv[2]==='mcp'){fs.appendFileSync(log+'.mcp',JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd()})+'\\n');process.stdout.write(${JSON.stringify(mcpList)});process.exit(0);}
fs.appendFileSync(log,JSON.stringify({argv:process.argv.slice(2),codexHome:process.env.CODEX_HOME??null})+'\\n');
function send(x){process.stdout.write(JSON.stringify(x)+'\\n')}
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\\n');
 if(m.method==='initialize') send({id:m.id,result:{}});
 else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread-cli'}}});
 else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'turn-1',status:'inProgress'}}});send({id:700,method:'item/fileChange/requestApproval',params:{reason:'native write'}});}
 else if(m.id===700){send({id:900,method:'item/tool/call',params:{callId:'call-1',tool:'crew_workspace_action',arguments:{}}});}
 else if(m.id===900){send({method:'item/agentMessage/delta',params:{delta:'cli reply'}});send({method:'turn/completed',params:{turn:{status:'completed',error:null}}});}
});`, { mode: 0o755 });
  return server;
}

function readLog(log: string): Array<Record<string, any>> {
  return fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
}

describe("bring-your-own Codex CLI provider", () => {
  it("is a builtin that an extension cannot impersonate", () => {
    expect(isCodexCliProvider(provider)).toBe(true);
    expect(isCodexCliProvider({ ...provider, kind: "extension" })).toBe(false);
  });

  it("locks hosted-tools-only sessions to dynamic tools with a read-only sandbox and the user's own CODEX_HOME", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-cli-"));
    const log = path.join(dir, "log.jsonl");
    process.env.CREWCODER_HOME = dir;
    process.env.CREWCODER_CODEX_PATH = writeFakeCodex(dir, log);
    delete process.env.CODEX_HOME;
    const executed: string[] = [];
    const questions: string[] = [];

    const result = await runCodexCliProvider({
      provider, prompt: "make a task", cwd: dir, model: "gpt-test",
      modelInput: { systemPrompt: "system", messages: [textMessage("user", "make a task")], useProviderNativeFileTools: false, approvalMode: "review", availableTools: [{ name: "crew_workspace_action", description: "typed" }] },
      stream: {
        requestQuestion: async (question: { title: string }) => { questions.push(question.title); return "accept"; },
        executeTool: async (call: ToolCallPart) => { executed.push(call.name); return { role: "toolResult" as const, toolCallId: call.id, toolName: call.name, content: [{ type: "text" as const, text: "ok" }], isError: false, timestamp: Date.now() }; }
      }
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("cli reply");
    expect(executed).toEqual(["crew_workspace_action"]);
    // Native approval requests are declined without asking, even when the session would normally ask.
    expect(questions).toEqual([]);
    const entries = readLog(log);
    expect(entries[0]?.codexHome).toBeNull();
    const argv = entries[0]?.argv as string[];
    for (const feature of CODEX_NATIVE_TOOL_FEATURES) expect(argv).toContain(feature);
    expect(argv).toContain("web_search=disabled");
    expect(argv).toContain("agents.max_depth=0");
    expect(argv).not.toContain("code_mode_host");
    expect(argv).toContain("mcp_servers.node_repl.enabled=false");
    expect(argv).toContain("mcp_servers.computer-use.enabled=false");
    // MCP servers are listed from the session folder so trusted project configs are covered.
    expect(JSON.parse(fs.readFileSync(`${log}.mcp`, "utf8").trim())).toMatchObject({ argv: ["mcp", "list", "--json"], cwd: fs.realpathSync(dir) });
    expect(argv.indexOf("app-server")).toBeGreaterThan(argv.lastIndexOf("--disable"));
    const threadStart = entries.find((entry) => entry.method === "thread/start");
    expect(threadStart?.params).toMatchObject({ approvalPolicy: "never", sandbox: "read-only" });
    expect(threadStart?.params.dynamicTools.map((tool: { name: string }) => tool.name)).toEqual(["crew_workspace_action"]);
    expect(entries.find((entry) => entry.method === "turn/start")?.params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } });
    expect(entries.find((entry) => entry.id === 700)?.result).toEqual({ decision: "decline" });
    // CrewCoder never copies the user's Codex login into its own store.
    expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
  });

  it("keeps native tools and normal permissions when CrewCoder owns the filesystem", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-cli-"));
    const log = path.join(dir, "log.jsonl");
    process.env.CREWCODER_HOME = dir;
    process.env.CREWCODER_CODEX_PATH = writeFakeCodex(dir, log);
    await runCodexCliProvider({
      provider, prompt: "hi", cwd: dir, model: "gpt-test",
      modelInput: { systemPrompt: "system", messages: [textMessage("user", "hi")], approvalMode: "never", availableTools: [] },
      stream: { executeTool: async (call: ToolCallPart) => ({ role: "toolResult" as const, toolCallId: call.id, toolName: call.name, content: [{ type: "text" as const, text: "ok" }], isError: false, timestamp: Date.now() }) }
    });
    const entries = readLog(log);
    expect(entries[0]?.argv).toEqual(["app-server", "--stdio"]);
    expect(fs.existsSync(`${log}.mcp`)).toBe(false);
    expect(entries.find((entry) => entry.method === "thread/start")?.params).toMatchObject({ sandbox: "workspace-write" });
  });

  it("fails with a sign-in hint instead of falling back to CrewCoder-owned credentials", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-cli-"));
    process.env.CREWCODER_HOME = dir;
    process.env.CREWCODER_CODEX_PATH = path.join(dir, "missing-codex");
    // A binary missing from PATH is the common cause (for example an app launched without the user's shell PATH).
    await expect(runCodexCliProvider({
      provider, prompt: "hi", cwd: dir, model: "gpt-test",
      modelInput: { systemPrompt: "system", messages: [textMessage("user", "hi")], availableTools: [] }
    })).rejects.toThrow(/Codex CLI was not found: .*missing-codex.*CREWCODER_CODEX_PATH/);
  });

  it("reports why an installed Codex CLI could not start", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-cli-"));
    process.env.CREWCODER_HOME = dir;
    const broken = path.join(dir, "broken-codex.cjs");
    fs.writeFileSync(broken, "#!/usr/bin/env node\nprocess.stderr.write('error: unexpected argument --stdio\\n');process.exit(2);\n", { mode: 0o755 });
    process.env.CREWCODER_CODEX_PATH = broken;
    await expect(runCodexCliProvider({
      provider, prompt: "hi", cwd: dir, model: "gpt-test",
      modelInput: { systemPrompt: "system", messages: [textMessage("user", "hi")], availableTools: [] }
    })).rejects.toThrow(/could not start \(.*unexpected argument --stdio/);
  });

  it("refuses to start when an MCP server cannot be disabled safely", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-cli-"));
    const log = path.join(dir, "log.jsonl");
    process.env.CREWCODER_HOME = dir;
    process.env.CREWCODER_CODEX_PATH = writeFakeCodex(dir, log, '[{"name":"evil.enabled=true,x","enabled":true}]');
    await expect(runCodexCliProvider({
      provider, prompt: "hi", cwd: dir, model: "gpt-test",
      modelInput: { systemPrompt: "system", messages: [textMessage("user", "hi")], useProviderNativeFileTools: false, availableTools: [] }
    })).rejects.toThrow(/could not be locked/);
    expect(fs.existsSync(log)).toBe(false);
  });

  it("parses codex mcp list output strictly", () => {
    expect(parseCodexMcpServerNames('[{"name":"a_b-1"}]')).toEqual(["a_b-1"]);
    expect(parseCodexMcpServerNames("[]")).toEqual([]);
    expect(() => parseCodexMcpServerNames("{}")).toThrow();
    expect(() => parseCodexMcpServerNames("nope")).toThrow();
    expect(() => parseCodexMcpServerNames('[{"name":"a b"}]')).toThrow();
    expect(codexHostedToolsOnlyArgs([])).not.toContain("mcp_servers");
  });
});
