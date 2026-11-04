import * as childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { codexToolResult } from "../crewcoder-agent/src/providers/codex-tool-images.js";
import { readTool } from "../crewcoder-agent/src/tools/read.js";
import { runCodexCliProvider } from "../crewcoder-agent/src/providers/codex-app-server-provider.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==", "base64");
const roots: string[] = [];
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof childProcess>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it("forwards a real read-tool PNG to Codex without enabling native tools", async () => {
  fs.mkdirSync(process.env.CREWCODER_HOME!, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.CREWCODER_HOME!, "image-wire-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "screen.png"), png);
  const fixture = path.join(root, "fake-codex.cjs");
  const wireLog = path.join(root, "tool-response.json");
  fs.writeFileSync(fixture, `
const fs = require("node:fs");
const readline = require("node:readline");
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
if (process.argv[2] === "mcp") { process.stdout.write("[]"); process.exit(0); }
readline.createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: {} });
  if (m.method === "thread/start") {
    fs.writeFileSync(${JSON.stringify(path.join(root, "thread.json"))}, JSON.stringify(m.params));
    send({ id: m.id, result: { thread: { id: "image-thread" } } });
  }
  if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "image-turn" } } });
    send({ id: 900, method: "item/tool/call", params: { callId: "image-read", tool: "read", arguments: { path: "screen.png" } } });
  }
  if (m.id === 900) {
    fs.writeFileSync(${JSON.stringify(wireLog)}, JSON.stringify(m.result));
    send({ method: "item/agentMessage/delta", params: { delta: "received tool result" } });
    send({ method: "turn/completed", params: { turn: { status: "completed" } } });
  }
});
`);
  const launches: string[][] = [];
  const { spawn: originalSpawn } = await vi.importActual<typeof childProcess>("node:child_process");
  vi.mocked(childProcess.spawn).mockImplementation(((command, args, options) => {
    launches.push(args);
    return originalSpawn(process.execPath, [fixture, ...args], options);
  }) as typeof childProcess.spawn);
  const result = await runCodexCliProvider({
    provider: { id: "codex-cli", title: "Codex", kind: "builtin", runtime: "openai-codex-responses", command: "codex", args: [] },
    cwd: root, prompt: "inspect screen", model: "test-model",
    modelInput: {
      systemPrompt: "test", messages: [{ role: "user", content: [{ type: "text", text: "inspect screen" }], timestamp: 0 }],
      useProviderNativeFileTools: false, availableTools: [{ name: readTool.name, description: readTool.description, parameters: readTool.parameters }]
    },
    stream: {
      executeTool: async call => ({
        role: "toolResult", toolCallId: call.id, toolName: call.name, isError: false, timestamp: 0,
        ...await readTool.execute(readTool.parse(call.arguments), { cwd: root, mode: "general", sessionId: "test", mutationLog: [] })
      })
    }
  });
  expect(result.exitCode).toBe(0);
  const wire = JSON.parse(fs.readFileSync(wireLog, "utf8"));
  expect(wire.success).toBe(true);
  expect(wire.contentItems).toContainEqual({ type: "inputImage", imageUrl: "data:image/png;base64," + png.toString("base64") });
  expect(JSON.parse(fs.readFileSync(path.join(root, "thread.json"), "utf8")).sandbox).toBe("read-only");
  expect(launches[1]).toContain("view_image");
  expect(launches[1]).toContain("--disable");
});

function imageResult(root: string, files = ["screen.png"]) {
  return {
    role: "toolResult" as const, toolCallId: "read", toolName: "read", isError: false, timestamp: 0,
    content: [{ type: "text" as const, text: "image description" }],
    details: { images: files.map(file => ({ path: path.join(root, file), mime: "image/png", displayPath: file, byteSize: png.length })) }
  };
}

function workspace() {
  fs.mkdirSync(process.env.CREWCODER_HOME!, { recursive: true });
  const root = fs.mkdtempSync(path.join(process.env.CREWCODER_HOME!, "image-case-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "screen.png"), png);
  return root;
}

it("keeps ordinary text results unchanged and does not read error attachments", async () => {
  const root = workspace();
  const text = { ...imageResult(root), details: undefined };
  expect(await codexToolResult(text, root)).toEqual({ contentItems: [{ type: "inputText", text: "image description" }], success: true });
  expect(await codexToolResult({ ...imageResult(root, ["missing.png"]), isError: true }, root)).toEqual({ contentItems: [{ type: "inputText", text: "image description" }], success: false });
});

it("fails visibly if a transient screen disappeared, with no partial images", async () => {
  const root = workspace();
  const result = await codexToolResult(imageResult(root, ["screen.png", "missing.png"]), root);
  expect(result.success).toBe(false);
  expect(result.contentItems).toHaveLength(1);
  expect(result.contentItems[0]).toMatchObject({ type: "inputText", text: expect.stringContaining("Image delivery failed:") });
});

it("checks workspace scope again and honors session external-directory grants", async () => {
  const root = workspace(), other = workspace();
  const result = imageResult(other);
  expect((await codexToolResult(result, root)).success).toBe(false);
  expect((await codexToolResult(result, root, [other])).contentItems[1]).toMatchObject({ type: "inputImage" });
});

it("rejects oversized files before allocating image content", async () => {
  const root = workspace();
  fs.truncateSync(path.join(root, "screen.png"), 8 * 1024 * 1024 + 1);
  const result = await codexToolResult(imageResult(root), root);
  expect(result.success).toBe(false);
  expect(result.contentItems[0]).toMatchObject({ text: expect.stringContaining("size limit") });
});

it("sniffs bytes instead of trusting claimed PNG metadata", async () => {
  const root = workspace();
  fs.writeFileSync(path.join(root, "screen.png"), "not a PNG");
  expect((await codexToolResult(imageResult(root), root)).success).toBe(false);
});

it("bounds attachment count and rejects malformed metadata", async () => {
  const root = workspace();
  expect((await codexToolResult(imageResult(root, Array(5).fill("screen.png")), root)).success).toBe(false);
  const malformed = { ...imageResult(root), details: { images: [{ path: 42 }] } };
  expect((await codexToolResult(malformed, root)).success).toBe(false);
});

it("bounds the combined payload and keeps bytes out of the persisted tool result", async () => {
  const root = workspace();
  const file = path.join(root, "screen.png");
  fs.truncateSync(file, 6 * 1024 * 1024);
  const result = imageResult(root, ["screen.png", "screen.png", "screen.png"]);
  expect((await codexToolResult(result, root)).success).toBe(false);
  expect(JSON.stringify(result)).not.toContain("base64");
});

