import { createJsonEventSink } from "../core/json-event-stream.js";
import { CodexProgress } from "../providers/codex-progress.js";
import { translateEvent } from "../acp/event-translator.js";
import * as childProcess from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { textMessage, type ToolCallPart } from "../core/messages.js";
import { setAuthCredential } from "../providers/auth-store.js";
import { codexAppServerContextArgs, codexAppServerPoolSize, codexTurnPermissions, enableCodexAppServerPooling, formatCodexCommandResult, formatCodexFileChangeResult, runCodexAppServerProvider } from "../providers/codex-app-server-provider.js";
import type { ProviderDefinition } from "../providers/types.js";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof childProcess>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

beforeEach(async () => {
  const { spawn } = await vi.importActual<typeof childProcess>("node:child_process");
  // Windows cannot execute a .cjs shebang; run fake wire servers on Node everywhere.
  vi.mocked(childProcess.spawn).mockImplementation(((command: string, args: readonly string[] = [], options: childProcess.SpawnOptions = {}) =>
    command.endsWith(".cjs")
      ? spawn(process.execPath, [command, ...args], options)
      : spawn(command, args, options)) as typeof childProcess.spawn);
});

const originalHome = process.env.CREWCODER_HOME;
const originalCodexPath = process.env.CREWCODER_CODEX_PATH;
const provider: ProviderDefinition = { id: "codex", title: "Codex", kind: "builtin", runtime: "openai-codex-responses", command: "http", args: [], endpoint: "https://chatgpt.com/backend-api/codex/responses" };

afterEach(() => {
  vi.restoreAllMocks();
  enableCodexAppServerPooling(false);
  if (originalHome === undefined) delete process.env.CREWCODER_HOME; else process.env.CREWCODER_HOME = originalHome;
  if (originalCodexPath === undefined) delete process.env.CREWCODER_CODEX_PATH; else process.env.CREWCODER_CODEX_PATH = originalCodexPath;
});

describe("Codex app-server provider", () => {
  it("pins native Codex compaction to CrewCoder's resolved model policy", () => {
    expect(codexAppServerContextArgs({
      systemPrompt: "system",
      messages: [],
      availableTools: [],
      contextWindow: 1_050_000,
      autoCompactTokenLimit: 630_000
    })).toEqual([
      "-c", "model_context_window=1050000",
      "-c", "model_auto_compact_token_limit=630000",
      "-c", 'model_auto_compact_token_limit_scope="total"'
    ]);
    expect(codexAppServerContextArgs({ systemPrompt: "system", messages: [], availableTools: [] })).toEqual([]);
  });

  it("does not start app-server when a virtual filesystem disables provider-native file tools", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-home-"));
    const marker = path.join(home, "app-server-started");
    const server = path.join(home, "fake-codex.cjs");
    fs.writeFileSync(server, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');\n`, { mode: 0o755 });
    process.env.CREWCODER_HOME = home;
    process.env.CREWCODER_CODEX_PATH = server;

    const result = await runCodexAppServerProvider({
      provider,
      prompt: "write remotely",
      cwd: "/remote/project",
      model: "gpt-test",
      modelInput: { systemPrompt: "system", messages: [textMessage("user", "write remotely")], useProviderNativeFileTools: false, availableTools: [{ name: "write", description: "host-backed write" }] }
    });

    expect(result).toBeUndefined();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("persists a durable thread id and resumes it with only the latest prompt", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-home-"));
    const log = path.join(home, "requests.jsonl");
    const server = path.join(home, "fake-codex.cjs");
    fs.writeFileSync(server, `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
const log=${JSON.stringify(log)}; let turn=0;
fs.appendFileSync(log,JSON.stringify({argv:process.argv.slice(2)})+'\\n');
function send(x){process.stdout.write(JSON.stringify(x)+'\\n')}
const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\\n');
 if(m.method==='initialize') send({id:m.id,result:{}});
 else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread-durable'}}});
 else if(m.method==='thread/resume') send({id:m.id,result:{thread:{id:m.params.threadId}}});
 else if(m.method==='turn/start'){turn++;send({id:m.id,result:{turn:{id:'turn-'+turn,status:'inProgress'}}});send({id:900,method:'item/tool/call',params:{callId:'call-1',tool:'noop',arguments:{value:'safe'}}});}
 else if(m.id===900&&m.result){send({method:'item/started',params:{item:{type:'contextCompaction',id:'compact-1'}}});send({method:'item/completed',params:{item:{type:'contextCompaction',id:'compact-1'}}});send({method:'thread/compacted',params:{threadId:'thread-durable',turnId:'turn-'+turn}});send({method:'item/agentMessage/delta',params:{delta:'durable reply'}});send({method:'thread/tokenUsage/updated',params:{tokenUsage:{total:{inputTokens:90000,outputTokens:700,totalTokens:90700},last:{inputTokens:42000,outputTokens:700,totalTokens:42700},modelContextWindow:258400}}});send({method:'turn/completed',params:{turn:{status:'completed',error:null}}});}
});`, { mode: 0o755 });
    process.env.CREWCODER_HOME = home;
    process.env.CREWCODER_CODEX_PATH = server;
    setAuthCredential("codex", { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3_600_000, accountId: "account", idToken: "id-token" });
    let sessionId = "";
    const executed: string[] = [];
    const compactions: string[] = [];
    const baseInput = {
      provider, prompt: "new prompt", cwd: home, model: "gpt-test",
      modelInput: { systemPrompt: "system", messages: [textMessage("user", "old prompt"), textMessage("user", "new prompt")], approvalMode: "never" as const, contextWindow: 1_050_000, autoCompactTokenLimit: 630_000, availableTools: [{ name: "noop", description: "safe test tool", parameters: { type: "object" as const, properties: { value: { type: "string" as const } } } }], session: { sessionId: "crew", continuation: true } },
      stream: {
        onProviderSessionId: (id: string) => { sessionId = id; },
        onProviderCompaction: (update: { status: string }) => { compactions.push(update.status); },
        executeTool: async (call: ToolCallPart) => { executed.push(call.name); return { role: "toolResult" as const, toolCallId: "call-1", toolName: call.name, content: [{ type: "text" as const, text: "ok" }], isError: false, timestamp: Date.now() }; }
      }
    };
    const first = await runCodexAppServerProvider(baseInput);
    expect(first?.exitCode).toBe(0);
    expect(first?.usage).toMatchObject({
      inputTokens: 42_000,
      outputTokens: 700,
      totalTokens: 42_700,
      contextTokens: 42_000,
    });
    expect(first?.usage).not.toHaveProperty("contextWindow");
    expect(compactions).toEqual(["started", "completed"]);
    expect(sessionId).toContain("thread-durable");
    const initialRequests = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(initialRequests[0]?.argv).toEqual([
      "app-server", "--stdio",
      "-c", "model_context_window=1050000",
      "-c", "model_auto_compact_token_limit=630000",
      "-c", 'model_auto_compact_token_limit_scope="total"'
    ]);
    const threadStart = initialRequests.find((request) => request.method === "thread/start") as { params: Record<string, unknown> };
    expect(threadStart.params).not.toHaveProperty("baseInstructions");
    expect(threadStart.params.approvalPolicy).toBe("never");
    expect(threadStart.params.sandbox).toBe("workspace-write");
    expect(threadStart.params.developerInstructions).toContain("system");

    fs.writeFileSync(log, "");
    const second = await runCodexAppServerProvider({ ...baseInput, modelInput: { ...baseInput.modelInput, session: { ...baseInput.modelInput.session, providerSessionId: sessionId } } });
    expect(second?.exitCode).toBe(0);
    expect(compactions).toEqual(["started", "completed", "started", "completed"]);
    expect(executed).toEqual(["noop", "noop"]);
    const requests = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests.some((request) => request.method === "thread/resume")).toBe(true);
    const turn = requests.find((request) => request.method === "turn/start") as { params: { input: Array<{ text?: string }>; summary?: string; approvalPolicy?: unknown; sandboxPolicy?: unknown } };
    expect(turn.params.input[0]?.text).toBe("new prompt");
    expect(turn.params.input[0]?.text).not.toContain("old prompt");
    expect(turn.params.summary).toBe("auto");
    expect(turn.params.approvalPolicy).toBe("never");
    expect(turn.params.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  });

  it("reuses one pooled app-server per session without re-resuming a loaded thread", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-home-"));
    const log = path.join(home, "requests.jsonl");
    const server = path.join(home, "fake-codex.cjs");
    fs.writeFileSync(server, `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
const log=${JSON.stringify(log)}; let turn=0;
fs.appendFileSync(log,JSON.stringify({spawn:process.pid})+'\\n');
function send(x){process.stdout.write(JSON.stringify(x)+'\\n')}
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({method:m.method})+'\\n');
 if(m.method==='initialize') send({id:m.id,result:{}});
 else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread-pooled'}}});
 else if(m.method==='thread/resume') send({id:m.id,result:{thread:{id:m.params.threadId}}});
 else if(m.method==='turn/start'){turn++;send({id:m.id,result:{turn:{id:'turn-'+turn,status:'inProgress'}}});
  if(m.params.input[0].text==='hang') return;
  send({method:'item/agentMessage/delta',params:{delta:'reply '+turn}});send({method:'turn/completed',params:{turn:{status:'completed',error:null}}});}
});`, { mode: 0o755 });
    process.env.CREWCODER_HOME = home;
    process.env.CREWCODER_CODEX_PATH = server;
    setAuthCredential("codex", { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3_600_000, accountId: "account", idToken: "id-token" });
    enableCodexAppServerPooling();
    const entries = () => fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { spawn?: number; method?: string });
    let providerSessionId = "";
    const run = (prompt: string, session = "crew-a", signal?: AbortSignal) => runCodexAppServerProvider({
      provider, prompt, cwd: home, model: "gpt-test",
      modelInput: { systemPrompt: "system", messages: [textMessage("user", prompt)], approvalMode: "never", availableTools: [], session: { sessionId: session, continuation: true, providerSessionId: providerSessionId || undefined } },
      stream: { onProviderSessionId: (id: string) => { providerSessionId = id; } }
    }, signal);

    expect((await run("one"))?.stdout).toBe("reply 1");
    expect((await run("two"))?.stdout).toBe("reply 2");
    expect((await run("three"))?.stdout).toBe("reply 3");
    expect(entries().filter((entry) => entry.spawn).length).toBe(1);
    expect(entries().filter((entry) => entry.method === "initialize").length).toBe(1);
    expect(entries().filter((entry) => entry.method === "thread/start").length).toBe(1);
    expect(entries().filter((entry) => entry.method === "thread/resume").length).toBe(0);
    expect(codexAppServerPoolSize()).toBe(1);

    // A different CrewCoder session gets its own process.
    const saved = providerSessionId;
    providerSessionId = "";
    await run("other", "crew-b");
    expect(entries().filter((entry) => entry.spawn).length).toBe(2);
    providerSessionId = saved;

    // An aborted turn is never reused: the process is closed and the next turn resumes on a fresh one.
    const controller = new AbortController();
    const hung = run("hang", "crew-a", controller.signal);
    setTimeout(() => controller.abort(), 100);
    await hung.catch(() => undefined);
    fs.writeFileSync(log, "");
    expect((await run("after abort"))?.exitCode).toBe(0);
    expect(entries().filter((entry) => entry.spawn).length).toBe(1);
    expect(entries().filter((entry) => entry.method === "thread/resume").length).toBe(1);
  });

  it("keeps one app-server per turn when pooling is not enabled", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-home-"));
    const log = path.join(home, "spawns.log");
    const server = path.join(home, "fake-codex.cjs");
    fs.writeFileSync(server, `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
fs.appendFileSync(${JSON.stringify(log)},'spawn\\n');
function send(x){process.stdout.write(JSON.stringify(x)+'\\n')}
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 else if(m.method==='thread/start'||m.method==='thread/resume') send({id:m.id,result:{thread:{id:'thread-once'}}});
 else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'t',status:'inProgress'}}});send({method:'item/agentMessage/delta',params:{delta:'ok'}});send({method:'turn/completed',params:{turn:{status:'completed',error:null}}});}
});`, { mode: 0o755 });
    process.env.CREWCODER_HOME = home;
    process.env.CREWCODER_CODEX_PATH = server;
    setAuthCredential("codex", { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3_600_000, accountId: "account", idToken: "id-token" });
    const input = { provider, prompt: "hi", cwd: home, model: "gpt-test", modelInput: { systemPrompt: "system", messages: [textMessage("user", "hi")], approvalMode: "never" as const, availableTools: [], session: { sessionId: "crew", continuation: true } } };
    await runCodexAppServerProvider(input);
    await runCodexAppServerProvider(input);
    expect(fs.readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
    expect(codexAppServerPoolSize()).toBe(0);
  });

  it("routes commentary and the final answer through assistant dialogue, keeping reasoning separate", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-home-"));
    const server = path.join(home, "fake-codex.cjs");
    fs.writeFileSync(server, `#!/usr/bin/env node
const readline=require('node:readline');
function send(x){process.stdout.write(JSON.stringify(x)+'\\n')}
const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize') send({id:m.id,result:{}});
 else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread-commentary'}}});
 else if(m.method==='turn/start'){
  send({id:m.id,result:{turn:{id:'turn-1',status:'inProgress'}}});
  send({id:901,method:'item/commandExecution/requestApproval',params:{reason:'Inspect the repository',command:'pwd'}});
 }
 else if(m.id===901&&m.result?.decision==='accept'){
  send({method:'item/reasoning/summaryTextDelta',params:{itemId:'reasoning-1',delta:'**Planning repository inspection**'}});
  send({method:'item/completed',params:{item:{id:'summary-only',type:'reasoning',summary:['Completed summary only.'],content:[]}}});
  send({method:'item/reasoning/textDelta',params:{itemId:'reasoning-1',delta:'Raw reasoning'}});
  send({method:'item/completed',params:{item:{id:'reasoning-1',type:'reasoning',summary:['**Planning repository inspection**'],content:['Raw reasoning from content.']}}});
  send({method:'item/reasoning/summaryTextDelta',params:{itemId:'summary-partial',delta:'Partial '}});
  send({method:'item/completed',params:{item:{id:'summary-partial',type:'reasoning',summary:['Partial summary.'],content:[]}}});
  send({method:'item/completed',params:{item:{id:'summary-partial',type:'reasoning',summary:['Partial summary.'],content:[]}}});
  send({method:'item/started',params:{item:{id:'commentary-1',type:'agentMessage',text:'',phase:'commentary'}}});
  send({method:'item/agentMessage/delta',params:{itemId:'commentary-1',delta:"I'll inspect the repository first."}});
  send({method:'item/completed',params:{item:{id:'commentary-1',type:'agentMessage',text:"I'll inspect the repository first.",phase:'commentary'}}});
  send({method:'item/started',params:{item:{id:'final-1',type:'agentMessage',text:'',phase:'final_answer'}}});
  send({method:'item/agentMessage/delta',params:{itemId:'final-1',delta:'Inspection complete.'}});
  send({method:'turn/completed',params:{turn:{status:'completed',error:null}}});
 }
});`, { mode: 0o755 });
    process.env.CREWCODER_HOME = home;
    process.env.CREWCODER_CODEX_PATH = server;
    setAuthCredential("codex", { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3_600_000, accountId: "account", idToken: "id-token" });
    const thinking: string[] = [];
    const assistant: string[] = [];
    const questions: string[] = [];

    const result = await runCodexAppServerProvider({
      provider,
      prompt: "inspect",
      cwd: home,
      model: "gpt-test",
      modelInput: { systemPrompt: "system", messages: [textMessage("user", "inspect")], availableTools: [] },
      stream: {
        onThinkingDelta: (text) => { thinking.push(text); },
        onAssistantDelta: (text) => { assistant.push(text); },
        requestQuestion: async (question) => { questions.push(question.title); return "accept"; }
      }
    });

    expect(result?.exitCode).toBe(0);
    expect(thinking.filter(Boolean)).toEqual(["**Planning repository inspection**", "\n\nCompleted summary only.", "\n\nRaw reasoning", " from content.", "\n\nPartial ", "summary.", "\n\nI'll inspect the repository first."]);
    expect(assistant).toEqual(["I'll inspect the repository first.", "\n\nInspection complete."]);
    expect(questions).toEqual(["Inspect the repository"]);
    expect(JSON.parse(result?.text ?? "{}").content).toEqual([{ type: "text", text: "I'll inspect the repository first.\n\nInspection complete." }]);
  });

  it("preserves a failed file change error instead of reporting only its proposed patch", () => {
    expect(formatCodexFileChangeResult({
      status: "failed",
      changes: [{ path: "remote.txt", kind: "add", diff: "+text" }],
      error: { message: "workspace patch gate rejected the remote path" }
    })).toBe('workspace patch gate rejected the remote path\n\nProposed changes:\n[{"path":"remote.txt","kind":"add","diff":"+text"}]');
  });

  it("reports native command status when Codex returns no aggregated output", () => {
    expect(formatCodexCommandResult({ status: "failed", aggregatedOutput: "", exitCode: 1 }))
      .toBe("Codex command failed with exit code 1.");
    expect(formatCodexCommandResult({ status: "declined", aggregatedOutput: "" }))
      .toBe("Codex command was declined.");
    expect(formatCodexCommandResult({ status: "failed", aggregatedOutput: "", error: { message: "sandbox denied rm" } }))
      .toBe("sandbox denied rm");
  });

  it("uses network namespaces only for explicit sandboxed mode", () => {
    const input = (approvalMode: "review" | "sandboxed" | "full-access") => ({
      provider,
      prompt: "inspect",
      cwd: "/workspace",
      model: "gpt-test",
      modelInput: { systemPrompt: "system", messages: [], availableTools: [], approvalMode }
    });

    expect(codexTurnPermissions(input("review"))).toMatchObject({ sandboxPolicy: { networkAccess: true } });
    expect(codexTurnPermissions(input("sandboxed"))).toMatchObject({ sandboxPolicy: { networkAccess: false } });
    expect(codexTurnPermissions(input("full-access"))).toEqual({
      approvalPolicy: "on-request",
      sandboxPolicy: { type: "dangerFullAccess" }
    });
  });

  it("falls back to the direct transport for legacy credentials without an id token", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-home-"));
    process.env.CREWCODER_HOME = home;
    process.env.CREWCODER_CODEX_PATH = path.join(home, "does-not-matter");
    setAuthCredential("codex", { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3_600_000, accountId: "account" });
    const result = await runCodexAppServerProvider({ provider, prompt: "hello", cwd: home, model: "gpt-test", modelInput: { systemPrompt: "system", messages: [textMessage("user", "hello")], availableTools: [] } });
    expect(result).toBeUndefined();
  });
});

describe("Codex app-server thread continuity across machines", () => {
  const fakeServer = (home: string, log: string) => {
    const server = path.join(home, "fake-codex.cjs");
    fs.writeFileSync(server, `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
function send(x){process.stdout.write(JSON.stringify(x)+'\\n')}
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({method:m.method,threadId:m.params&&m.params.threadId})+'\\n');
 if(m.method==='initialize') send({id:m.id,result:{}});
 else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread-new'}}});
 else if(m.method==='thread/resume') send({id:m.id,result:{thread:{id:m.params.threadId}}});
 else if(m.method==='turn/start'){send({id:m.id,result:{turn:{id:'t',status:'inProgress'}}});send({method:'item/agentMessage/delta',params:{delta:'ok'}});send({method:'turn/completed',params:{turn:{status:'completed',error:null}}});}
});`, { mode: 0o755 });
    return server;
  };
  const setup = () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-move-"));
    const log = path.join(home, "requests.jsonl");
    process.env.CREWCODER_HOME = home;
    process.env.CREWCODER_CODEX_PATH = fakeServer(home, log);
    setAuthCredential("codex", { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3_600_000, accountId: "account", idToken: "id-token" });
    const methods = () => fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; threadId?: string });
    const folder = (name: string) => { const dir = path.join(home, name); fs.mkdirSync(dir, { recursive: true }); return dir; };
    return { log, methods, pcApp: folder("pc/dev/app"), vpsApp: folder("srv/work/app") };
  };
  // The workspace path appears in the system prompt too, as CrewMate's session prompt does.
  const run = (cwd: string, providerSessionId: string | undefined, model = "gpt-test") => {
    let saved = "";
    return runCodexAppServerProvider({
      provider, prompt: "next", cwd, model,
      modelInput: { systemPrompt: `system for ${cwd}`, messages: [textMessage("user", "earlier"), textMessage("user", "next")], approvalMode: "never", availableTools: [], session: { sessionId: "crew", continuation: true, providerSessionId } },
      stream: { onProviderSessionId: (id: string) => { saved = id; } }
    }).then((result) => ({ result, saved }));
  };

  it("resumes the same thread when only the workspace path changed, and not when the model changed", async () => {
    const { log, methods, pcApp, vpsApp } = setup();
    const pc = await run(pcApp, undefined);
    expect(pc.saved).toContain("thread-new");

    fs.writeFileSync(log, "");
    const vps = await run(vpsApp, pc.saved);
    expect(vps.result?.exitCode).toBe(0);
    expect(methods().filter((entry) => entry.method === "thread/resume")).toEqual([{ method: "thread/resume", threadId: "thread-new" }]);
    expect(methods().some((entry) => entry.method === "thread/start")).toBe(false);
    expect(vps.saved).toBe(pc.saved);

    fs.writeFileSync(log, "");
    await run(vpsApp, pc.saved, "gpt-other");
    expect(methods().some((entry) => entry.method === "thread/resume")).toBe(false);
    expect(methods().some((entry) => entry.method === "thread/start")).toBe(true);
  });

  it("still resumes threads saved with the hash format from before this change", async () => {
    const { log, methods, pcApp: cwd } = setup();
    const legacy = createHash("sha256").update(JSON.stringify({ model: "gpt-test", systemPrompt: `system for ${cwd}`, cwd, approvalMode: "never", tools: [] })).digest("hex").slice(0, 24);
    fs.writeFileSync(log, "");
    const result = await run(cwd, `codex-thread-v1:${legacy}:thread-old`);
    expect(methods().filter((entry) => entry.method === "thread/resume")).toEqual([{ method: "thread/resume", threadId: "thread-old" }]);
    expect(result.saved).toMatch(/^codex-thread-v1:[0-9a-f]{24}:thread-old$/);
    expect(result.saved).not.toContain(legacy);
  });
});

it("preserves indexed summaries, authoritative corrections and plan snapshots through ACP", () => {
  const state = new CodexProgress();
  state.handle("item/reasoning/summaryTextDelta", { itemId: "a", summaryIndex: 1, delta: "Second" });
  const update = state.handle("item/reasoning/summaryTextDelta", { itemId: "a", summaryIndex: 0, delta: "First" })[0]!;
  expect(update.progress.text).toBe("First\n\nSecond");
  const final = { item: { id: "a", type: "reasoning", summary: ["Corrected", "Second complete"], content: [] } };
  const completed = state.handle("item/completed", final)[0]!;
  expect(completed.progress.text).toBe("Corrected\n\nSecond complete");
  expect(completed.progress.completed).toBe(true);
  const translated = translateEvent({ type: "thinking_delta", text: completed.delta, progress: completed.progress });
  expect(translated).toMatchObject({ sessionUpdate: "agent_thought_chunk", _meta: { "crewcoder/progress": completed.progress } });
  expect(state.handle("item/completed", final)).toEqual([]);
  expect(state.handle("turn/plan/updated", { plan: [{ step: "Inspect", status: "inProgress" }] })[0]?.progress.text).toBe("inProgress: Inspect");
  state.handle("item/plan/delta", { itemId: "plan", delta: "Draft" });
  expect(state.handle("item/completed", { item: { id: "plan", type: "plan", text: "Final plan" } })[0]?.progress.text).toBe("Final plan");
});

it("keeps terminal thinking events text-only while ACP retains structured completion updates", async () => {
  const lines: string[] = [];
  const sink = createJsonEventSink(line => { lines.push(line); });
  const progress = { itemId: "a", kind: "summary" as const, text: "Summary", completed: false };
  await sink({ type: "thinking_delta", text: "Summary", progress });
  await sink({ type: "thinking_delta", text: "", progress: { ...progress, completed: true } });
  expect(lines).toHaveLength(1);
  expect(JSON.parse(lines[0]!)).toEqual({ type: "thinking_delta", text: "Summary", emittedAt: expect.any(String) });
  expect(translateEvent({ type: "thinking_delta", text: "", progress: { ...progress, completed: true } })).toMatchObject({
    sessionUpdate: "agent_thought_chunk", _meta: { "crewcoder/progress": { completed: true } }
  });
});
