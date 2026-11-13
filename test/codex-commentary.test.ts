import * as childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runCodexCliProvider } from "../crewcoder-agent/src/providers/codex-app-server-provider.js";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof childProcess>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
afterEach(() => vi.restoreAllMocks());

it.each(["streamed", "completed-only", "partial", "late-phase"] as const)(
  "publishes %s commentary before dispatch and preserves reasoning separately",
  async mode => {
    fs.mkdirSync(process.env.CREWCODER_HOME!, { recursive: true });
    const root = fs.mkdtempSync(path.join(process.env.CREWCODER_HOME!, "commentary-"));
    const fixture = path.join(root, "codex.cjs");
    const acknowledgement = "I'll start a background worker to wait 45 seconds, then write the file.";
    fs.writeFileSync(fixture, `
const readline = require("node:readline");
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
if (process.argv.includes("mcp")) { process.stdout.write("[]"); process.exit(0); }
const ack = ${JSON.stringify(acknowledgement)}, mode = ${JSON.stringify(mode)};
readline.createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "thread/start") send({ id: m.id, result: { thread: { id: "commentary-thread" } } });
  if (m.method === "turn/start") {
    send({ id: m.id, result: {} });
    send({ method: "item/reasoning/textDelta", params: { itemId: "r", delta: "Private reasoning." } });
    send({ method: "item/completed", params: { item: { id: "r", type: "reasoning", content: ["Private reasoning."] } } });
    // This attempt has only reasoning. The host must reject it.
    send({ id: 899, method: "item/tool/call", params: { tool: "start-worker", callId: "before", arguments: {} } });
  }
  if (m.id === 899) {
    if (mode !== "late-phase") send({ method: "item/started", params: { item: { id: "c", type: "agentMessage", phase: "commentary", text: "" } } });
    if (mode !== "completed-only") send({ method: "item/agentMessage/delta", params: { itemId: "c", delta: mode === "partial" ? ack.slice(0, 20) : ack } });
    send({ method: "item/completed", params: { item: { id: "c", type: "agentMessage", phase: "commentary", text: ack } } });
    send({ id: 900, method: "item/tool/call", params: { tool: "start-worker", callId: "after", arguments: {} } });
  }
  if (m.id === 900) {
    // A completion-only final answer must survive even after commentary was streamed.
    send({ method: "item/completed", params: { item: { id: "f", type: "agentMessage", phase: "final_answer", text: "Worker started." } } });
    send({ method: "turn/completed", params: { turn: { status: "completed" } } });
  }
});
`);
    const { spawn } = await vi.importActual<typeof childProcess>("node:child_process");
    vi.mocked(childProcess.spawn).mockImplementation(((command: string, args: readonly string[] = [], options: childProcess.SpawnOptions = {}) =>
      spawn(process.execPath, [fixture, ...args], options)) as typeof childProcess.spawn);
    const dialogue: string[] = [];
    const thinking: string[] = [];
    const allowed: boolean[] = [];
    const result = await runCodexCliProvider({
      provider: { id: "codex-cli", title: "Codex", kind: "builtin", runtime: "openai-codex-responses", command: "codex", args: [] },
      cwd: root, prompt: "start worker", model: "test",
      modelInput: {
        systemPrompt: "test", messages: [], useProviderNativeFileTools: false,
        availableTools: [{ name: "start-worker", description: "test dispatch" }]
      },
      stream: {
        onAssistantDelta: async text => {
          await new Promise(resolve => setTimeout(resolve, 5));
          dialogue.push(text);
        },
        onThinkingDelta: text => { thinking.push(text); },
        executeTool: async call => {
          // Only published assistant dialogue can satisfy the host's acknowledgement gate.
          const acknowledged = dialogue.join("") === acknowledgement;
          allowed.push(acknowledged);
          return { role: "toolResult", toolCallId: call.id, toolName: call.name,
            content: [{ type: "text", text: acknowledged ? "started" : "acknowledgement required" }],
            isError: !acknowledged, timestamp: 0 };
        }
      }
    });
    expect(result.exitCode).toBe(0);
    expect(allowed).toEqual([false, true]);
    expect(thinking.join("")).toBe("Private reasoning.\n\n" + acknowledgement);
    expect(dialogue.join("")).toBe(acknowledgement + "\n\nWorker started.");
    expect(JSON.parse(result.text).content).toEqual([{ type: "text", text: dialogue.join("") }]);
  }
);
