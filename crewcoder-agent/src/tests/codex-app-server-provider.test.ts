import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { textMessage, type ToolCallPart } from "../core/messages.js";
import { setAuthCredential } from "../providers/auth-store.js";
import { codexTurnPermissions, formatCodexCommandResult, formatCodexFileChangeResult, runCodexAppServerProvider } from "../providers/codex-app-server-provider.js";
import type { ProviderDefinition } from "../providers/types.js";

const originalHome = process.env.CREWCODER_HOME;
const originalCodexPath = process.env.CREWCODER_CODEX_PATH;
const provider: ProviderDefinition = { id: "codex", title: "Codex", kind: "builtin", runtime: "openai-codex-responses", command: "http", args: [], endpoint: "https://chatgpt.com/backend-api/codex/responses" };

afterEach(() => {
  if (originalHome === undefined) delete process.env.CREWCODER_HOME; else process.env.CREWCODER_HOME = originalHome;
  if (originalCodexPath === undefined) delete process.env.CREWCODER_CODEX_PATH; else process.env.CREWCODER_CODEX_PATH = originalCodexPath;
});

describe("Codex app-server provider", () => {
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
      modelInput: { systemPrompt: "system", messages: [textMessage("user", "old prompt"), textMessage("user", "new prompt")], approvalMode: "never" as const, availableTools: [{ name: "noop", description: "safe test tool", parameters: { type: "object" as const, properties: { value: { type: "string" as const } } } }], session: { sessionId: "crew", continuation: true } },
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
    expect(turn.params.summary).toBe("none");
    expect(turn.params.approvalPolicy).toBe("never");
    expect(turn.params.sandboxPolicy).toEqual({ type: "workspaceWrite", writableRoots: [], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  });

  it("routes commentary agent messages through thinking and keeps the final answer separate", async () => {
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
  send({method:'item/reasoning/summaryTextDelta',params:{delta:'**Planning repository inspection**'}});
  send({method:'item/reasoning/textDelta',params:{itemId:'reasoning-1',delta:'Raw reasoning'}});
  send({method:'item/completed',params:{item:{id:'reasoning-1',type:'reasoning',summary:['**Planning repository inspection**'],content:['Raw reasoning from content.']}}});
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
    expect(thinking).toEqual(["Raw reasoning", " from content.", "I'll inspect the repository first."]);
    expect(assistant).toEqual(["Inspection complete."]);
    expect(questions).toEqual(["Inspect the repository\npwd"]);
    expect(JSON.parse(result?.text ?? "{}").content).toEqual([{ type: "text", text: "Inspection complete." }]);
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
      approvalPolicy: "never",
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
