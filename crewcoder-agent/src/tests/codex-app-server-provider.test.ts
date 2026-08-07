import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { textMessage, type ToolCallPart } from "../core/messages.js";
import { setAuthCredential } from "../providers/auth-store.js";
import { runCodexAppServerProvider } from "../providers/codex-app-server-provider.js";
import type { ProviderDefinition } from "../providers/types.js";

const originalHome = process.env.CREWCODER_HOME;
const originalCodexPath = process.env.CREWCODER_CODEX_PATH;
const provider: ProviderDefinition = { id: "codex", title: "Codex", kind: "builtin", runtime: "openai-codex-responses", command: "http", args: [], endpoint: "https://chatgpt.com/backend-api/codex/responses" };

afterEach(() => {
  if (originalHome === undefined) delete process.env.CREWCODER_HOME; else process.env.CREWCODER_HOME = originalHome;
  if (originalCodexPath === undefined) delete process.env.CREWCODER_CODEX_PATH; else process.env.CREWCODER_CODEX_PATH = originalCodexPath;
});

describe("Codex app-server provider", () => {
  it("persists a durable thread id and resumes it with only the latest prompt", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-home-"));
    const log = path.join(home, "requests.jsonl");
    const server = path.join(home, "fake-codex.cjs");
    fs.writeFileSync(server, `#!/usr/bin/env node
const fs=require('node:fs'),readline=require('node:readline');
const log=${JSON.stringify(log)}; let turn=0;
function send(x){process.stdout.write(JSON.stringify(x)+'\\n')}
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\\n');
 if(m.method==='initialize') send({id:m.id,result:{}});
 else if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread-durable'}}});
 else if(m.method==='thread/resume') send({id:m.id,result:{thread:{id:m.params.threadId}}});
 else if(m.method==='turn/start'){turn++;send({id:m.id,result:{turn:{id:'turn-'+turn,status:'inProgress'}}});send({id:900,method:'item/tool/call',params:{callId:'call-1',tool:'noop',arguments:{value:'safe'}}});}
 else if(m.id===900&&m.result){send({method:'item/agentMessage/delta',params:{delta:'durable reply'}});send({method:'turn/completed',params:{turn:{status:'completed',error:null}}});}
});`, { mode: 0o755 });
    process.env.CREWCODER_HOME = home;
    process.env.CREWCODER_CODEX_PATH = server;
    setAuthCredential("codex", { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3_600_000, accountId: "account", idToken: "id-token" });
    let sessionId = "";
    const executed: string[] = [];
    const baseInput = {
      provider, prompt: "new prompt", cwd: home, model: "gpt-test",
      modelInput: { systemPrompt: "system", messages: [textMessage("user", "old prompt"), textMessage("user", "new prompt")], availableTools: [{ name: "noop", description: "safe test tool", parameters: { type: "object" as const, properties: { value: { type: "string" as const } } } }], session: { sessionId: "crew", continuation: true } },
      stream: {
        onProviderSessionId: (id: string) => { sessionId = id; },
        executeTool: async (call: ToolCallPart) => { executed.push(call.name); return { role: "toolResult" as const, toolCallId: "call-1", toolName: call.name, content: [{ type: "text" as const, text: "ok" }], isError: false, timestamp: Date.now() }; }
      }
    };
    const first = await runCodexAppServerProvider(baseInput);
    expect(first?.exitCode).toBe(0);
    expect(sessionId).toContain("thread-durable");

    fs.writeFileSync(log, "");
    const second = await runCodexAppServerProvider({ ...baseInput, modelInput: { ...baseInput.modelInput, session: { ...baseInput.modelInput.session, providerSessionId: sessionId } } });
    expect(second?.exitCode).toBe(0);
    expect(executed).toEqual(["noop", "noop"]);
    const requests = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(requests.some((request) => request.method === "thread/resume")).toBe(true);
    const turn = requests.find((request) => request.method === "turn/start") as { params: { input: Array<{ text?: string }> } };
    expect(turn.params.input[0]?.text).toBe("new prompt");
    expect(turn.params.input[0]?.text).not.toContain("old prompt");
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
