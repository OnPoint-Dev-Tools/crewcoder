import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexTurnPermissions, runCodexCliProvider } from "../providers/codex-app-server-provider.js";
import type { ProviderRunInput } from "../providers/types.js";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

const provider = { id: "codex-cli", title: "Codex CLI", kind: "builtin" as const, runtime: "process" as const, command: "codex", args: [] };
const consent = { mode: "form", serverName: "computer-use", message: "Allow computer access?", requestedSchema: { type: "object", properties: {} } };

afterEach(() => vi.clearAllMocks());

function server(request: Record<string, unknown>) {
  const frames: Array<Record<string, unknown>> = [];
  spawn.mockImplementation(() => {
    const stdout = new PassThrough();
    const stdin = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdin, stdout, stderr: new PassThrough(), exitCode: null, signalCode: null,
      kill: () => { stdout.end(); return true; }
    });
    const send = (value: unknown) => stdout.write(JSON.stringify(value) + "\n");
    stdin.on("data", (chunk: Buffer) => {
      const frame = JSON.parse(chunk.toString()) as Record<string, unknown>;
      frames.push(frame);
      if (frame.method === "initialize") send({ id: frame.id, result: {} });
      if (frame.method === "thread/start") send({ id: frame.id, result: { thread: { id: "thread" } } });
      if (frame.method === "turn/start") {
        send({ id: frame.id, result: {} });
        send(request);
      }
      if (frame.id === request.id && ("result" in frame || "error" in frame)) {
        send({ method: "item/agentMessage/delta", params: { delta: "Observed response" } });
        send({ method: "turn/completed", params: { turn: { status: "completed" } } });
      }
    });
    process.nextTick(() => child.emit("spawn"));
    return child;
  });
  return frames;
}

describe("Codex computer-use approval protocol", () => {
  it("routes native questions under Full access without auto-answering them", async () => {
    const frames = server({ id: "question", method: "item/tool/requestUserInput", params: { questions: [
      { id: "approach", question: "Which approach?", options: [{ label: "Minimal", description: "Small change" }], isOther: true }
    ] } });
    const requestQuestion = vi.fn().mockResolvedValue("custom approach");
    const result = await runCodexCliProvider({
      provider, prompt: "work", cwd: process.cwd(),
      modelInput: { systemPrompt: "", messages: [], availableTools: [], approvalMode: "full-access" },
      stream: { requestQuestion }
    }, AbortSignal.timeout(2_000));
    expect(result.exitCode).toBe(0);
    expect(requestQuestion).toHaveBeenCalledWith(expect.objectContaining({ title: "Which approach?", allowFreeform: true }));
    expect(frames.find(frame => frame.id === "question")?.result).toEqual({ answers: { approach: { answers: ["custom approach"] } } });
  });

  it("shows the exact sandbox extension and returns only the observed turn grant", async () => {
    const permissions = { fileSystem: { write: ["/repo/.git"] } };
    const frames = server({ id: "permissions", method: "item/permissions/requestApproval", params: { reason: "Commit approved changes", permissions } });
    const requestQuestion = vi.fn().mockResolvedValue("turn");
    await runCodexCliProvider({
      provider, prompt: "commit", cwd: process.cwd(),
      modelInput: { systemPrompt: "", messages: [], availableTools: [], approvalMode: "review" },
      stream: { requestQuestion }
    }, AbortSignal.timeout(2_000));
    expect(requestQuestion).toHaveBeenCalledWith(expect.objectContaining({ kind: "permission", detail: JSON.stringify(permissions, null, 2) }));
    expect(frames.find(frame => frame.id === "permissions")?.result).toEqual({ permissions, scope: "turn" });
  });
  it.each([902, "consent-request"])("returns explicit consent with the exact request id %s", async (id) => {
    const frames = server({ id, method: "mcpServer/elicitation/request", params: consent });
    const requestQuestion = vi.fn().mockResolvedValue("accept");
    const result = await runCodexCliProvider({
      provider, prompt: "inspect", cwd: process.cwd(),
      modelInput: { systemPrompt: "", messages: [], availableTools: [], approvalMode: "full-access" },
      stream: { requestQuestion }
    }, AbortSignal.timeout(2_000));
    expect(result.exitCode).toBe(0);
    expect(requestQuestion).toHaveBeenCalledOnce();
    expect(frames.find((frame) => frame.id === id)?.result).toEqual({ action: "accept", content: {} });
    expect(frames.filter((frame) => frame.method === "thread/start" || frame.method === "turn/start"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ params: expect.objectContaining({ approvalPolicy: "on-request", sandbox: "danger-full-access" }) }),
        expect.objectContaining({ params: expect.objectContaining({ approvalPolicy: "on-request", sandboxPolicy: { type: "dangerFullAccess" } }) })
      ]));
  });

  it("returns cancellation when no host can ask the user", async () => {
    const frames = server({ id: 902, method: "mcpServer/elicitation/request", params: consent });
    await runCodexCliProvider({
      provider, prompt: "inspect", cwd: process.cwd(),
      modelInput: { systemPrompt: "", messages: [], availableTools: [], approvalMode: "review" }
    }, AbortSignal.timeout(2_000));
    expect(frames.find((frame) => frame.id === 902)?.result).toEqual({ action: "cancel", content: null });
  });

  it.each(["never", "sandboxed"] as const)("refuses unsolicited consent under %s", async (approvalMode) => {
    const frames = server({ id: 902, method: "mcpServer/elicitation/request", params: consent });
    const requestQuestion = vi.fn().mockResolvedValue("accept");
    await runCodexCliProvider({
      provider, prompt: "inspect", cwd: process.cwd(),
      modelInput: { systemPrompt: "", messages: [], availableTools: [], approvalMode },
      stream: { requestQuestion }
    }, AbortSignal.timeout(2_000));
    expect(requestQuestion).not.toHaveBeenCalled();
    expect(frames.find((frame) => frame.id === 902)?.result).toEqual({ action: "decline", content: null });
  });

  it("refuses unknown server requests explicitly", async () => {
    const frames = server({ id: "unknown", method: "unknown/request", params: {} });
    await runCodexCliProvider({
      provider, prompt: "inspect", cwd: process.cwd(),
      modelInput: { systemPrompt: "", messages: [], availableTools: [] }
    }, AbortSignal.timeout(2_000));
    expect(frames.find((frame) => frame.id === "unknown")?.error).toMatchObject({ message: "Unsupported Codex server request: unknown/request" });
  });

  it("keeps Never, Sandboxed and hosted sessions fail closed", () => {
    const input = (approvalMode: "never" | "sandboxed" | "full-access"): ProviderRunInput => ({
      provider, prompt: "", cwd: process.cwd(),
      modelInput: { systemPrompt: "", messages: [], availableTools: [], approvalMode }
    });
    expect(codexTurnPermissions(input("never")).approvalPolicy).toBe("never");
    expect(codexTurnPermissions(input("sandboxed")).approvalPolicy).toBe("never");
    expect(codexTurnPermissions(input("full-access"), true)).toEqual({ approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } });
  });
});
