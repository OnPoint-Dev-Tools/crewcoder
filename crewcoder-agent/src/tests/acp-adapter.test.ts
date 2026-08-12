import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAcpServer } from "../acp/acp-server.js";
import type { AcpAgentOptions } from "../acp/acp-agent.js";
import { translateEvent } from "../acp/event-translator.js";
import { toolKind, toolLocations, toolTitle } from "../acp/tool-kind.js";
import type { AgentEvent } from "../core/events.js";
import { assistantText, textMessage, type ToolResultMessage } from "../core/messages.js";
import { createSessionId, loadSessionRecord, saveSession } from "../core/session-store.js";
import type { ToolContext } from "../core/tool-types.js";
import { readTextFile, writeTextFile } from "../tools/text-file-io.js";
import { createClientTextFileHost } from "../acp/client-files.js";

function toolResult(text: string, isError = false): ToolResultMessage {
  return { role: "toolResult", toolCallId: "tc-1", toolName: "read", content: [{ type: "text", text }], isError, timestamp: 0 };
}

/**
 * Drives the ACP server over in-memory streams, speaking raw JSON-RPC. This
 * exercises the real wire (framing included) without spawning a subprocess.
 */
function connect(options: AcpAgentOptions) {
  const toServer = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  createAcpServer({ ...options, input: toServer.readable, output: toClient.writable });

  const writer = toServer.writable.getWriter();
  const reader = toClient.readable.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  const pending: Record<string, unknown>[] = [];

  const send = (message: Record<string, unknown>): Promise<void> =>
    writer.write(encoder.encode(`${JSON.stringify(message)}\n`));

  const next = async (): Promise<Record<string, unknown>> => {
    while (!pending.length) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("stream closed before a message arrived");
      buffer += decoder.decode(chunk.value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) pending.push(JSON.parse(line) as Record<string, unknown>);
        index = buffer.indexOf("\n");
      }
    }
    return pending.shift() as Record<string, unknown>;
  };

  /** Reads until a response with the given id, collecting notifications seen on the way. */
  const awaitResponse = async (id: number) => {
    const notifications: Record<string, unknown>[] = [];
    for (;;) {
      const message = await next();
      if (message.id === id) return { response: message, notifications };
      notifications.push(message);
    }
  };

  return { send, next, awaitResponse };
}

describe("acp tool mapping", () => {
  it("maps CrewCoder tools onto ACP tool kinds", () => {
    expect(toolKind("read")).toBe("read");
    expect(toolKind("grep")).toBe("search");
    expect(toolKind("edit")).toBe("edit");
    expect(toolKind("bash")).toBe("execute");
  });

  it("degrades an unknown tool to `other` instead of throwing", () => {
    expect(toolKind("extension_acme_scan")).toBe("other");
  });

  it("titles bash by its command and file tools by their path", () => {
    expect(toolTitle("bash", { command: "npm test" })).toBe("npm test");
    expect(toolTitle("read", { path: "src/cli.ts" })).toBe("read src/cli.ts");
    expect(toolLocations({ path: "src/cli.ts" })).toEqual([{ path: "src/cli.ts" }]);
  });
});

describe("acp event translation", () => {
  it("maps assistant and thinking deltas to distinct update channels", () => {
    expect(translateEvent({ type: "assistant_delta", text: "hi" })).toEqual({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "hi" }
    });
    expect(translateEvent({ type: "thinking_delta", text: "hmm" })).toMatchObject({
      sessionUpdate: "agent_thought_chunk"
    });
  });

  it("emits rawInput on tool_call so clients can render arguments", () => {
    const update = translateEvent({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "read",
      args: { path: "src/cli.ts" }
    });
    expect(update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      kind: "read",
      status: "in_progress",
      rawInput: { path: "src/cli.ts" }
    });
  });

  it("marks a failed tool call as failed rather than completed", () => {
    const update = translateEvent({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "read",
      result: toolResult("boom", true),
      isError: true
    });
    expect(update).toMatchObject({ sessionUpdate: "tool_call_update", status: "failed" });
  });

  it("publishes compaction progress on the namespaced ACP channel", () => {
    expect(translateEvent({
      type: "session_compaction_progress",
      phase: "summarizing",
      percent: 35,
      message: "Summarizing older context…",
      originalMessageCount: 24
    })).toEqual({
      sessionUpdate: "_crewcoder/compaction_update",
      status: "started",
      automatic: true,
      phase: "summarizing",
      percent: 35,
      message: "Summarizing older context…",
      originalMessageCount: 24,
      retainedMessageCount: undefined
    });
  });

  it("publishes compaction completion without exposing the summary body", () => {
    const update = translateEvent({
      type: "session_compacted",
      compactionId: "compact-1",
      originalMessageCount: 24,
      retainedMessageCount: 8,
      summary: "private compacted session context"
    });
    expect(update).toEqual({
      sessionUpdate: "_crewcoder/compaction_update",
      status: "completed",
      automatic: true,
      percent: 100,
      message: "Context compacted. Continuing with the retained recent messages and summary.",
      compactionId: "compact-1",
      originalMessageCount: 24,
      retainedMessageCount: 8
    });
    expect(update).not.toHaveProperty("summary");
  });

  it("drops events with no faithful ACP representation", () => {
    const unmapped: AgentEvent = { type: "session_saved", sessionId: "s-1", path: "/tmp/s-1.json" };
    expect(translateEvent(unmapped)).toBeUndefined();
  });
});

describe("client filesystem routing", () => {
  const context = (textFiles?: ToolContext["textFiles"]): ToolContext => ({
    cwd: "/workspace",
    mode: "general",
    sessionId: "s-1",
    mutationLog: [],
    textFiles
  });

  it("falls back to local disk when the host offers no filesystem", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-fsio-"));
    const file = path.join(dir, "note.txt");
    await writeTextFile(context(), file, "from disk");
    expect(await readTextFile(context(), file)).toBe("from disk");
  });

  it("prefers the host filesystem over local disk when it is offered", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-fsio-"));
    const file = path.join(dir, "buffer.txt");
    fs.writeFileSync(file, "stale on disk", "utf8");

    const written: Array<{ path: string; content: string }> = [];
    const host = {
      readTextFile: async () => "unsaved editor buffer",
      writeTextFile: async (p: string, content: string) => { written.push({ path: p, content }); }
    };

    expect(await readTextFile(context(host), file)).toBe("unsaved editor buffer");
    await writeTextFile(context(host), file, "new content");
    expect(written).toEqual([{ path: file, content: "new content" }]);
    // The host owns the write; local disk must be left untouched.
    expect(fs.readFileSync(file, "utf8")).toBe("stale on disk");
  });

  it("mixes host reads with local writes when only read is offered", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-fsio-"));
    const file = path.join(dir, "partial.txt");
    const host = { readTextFile: async () => "from host" };

    expect(await readTextFile(context(host), file)).toBe("from host");
    await writeTextFile(context(host), file, "written locally");
    expect(fs.readFileSync(file, "utf8")).toBe("written locally");
  });

  it("creates parent directories only on the local path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-fsio-"));
    const nested = path.join(dir, "a", "b", "deep.txt");
    await writeTextFile(context(), nested, "nested");
    expect(fs.readFileSync(nested, "utf8")).toBe("nested");
  });
});

describe("client filesystem capability gating", () => {
  const fakeConn = () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    const conn = {
      readTextFile: async (params: Record<string, unknown>) => {
        calls.push({ method: "fs/read_text_file", params });
        return { content: "from client" };
      },
      writeTextFile: async (params: Record<string, unknown>) => {
        calls.push({ method: "fs/write_text_file", params });
        return {};
      }
    } as unknown as Parameters<typeof createClientTextFileHost>[0];
    return { conn, calls };
  };

  it("returns no host when the client declares no filesystem", () => {
    const { conn } = fakeConn();
    expect(createClientTextFileHost(conn, "s-1", undefined)).toBeUndefined();
    expect(createClientTextFileHost(conn, "s-1", { fs: { readTextFile: false, writeTextFile: false } })).toBeUndefined();
  });

  it("wires only the capabilities the client actually claimed", () => {
    const { conn } = fakeConn();
    const readOnly = createClientTextFileHost(conn, "s-1", { fs: { readTextFile: true, writeTextFile: false } });
    expect(readOnly?.readTextFile).toBeTypeOf("function");
    // Leaving writeTextFile undefined is what makes writes fall back to local disk.
    expect(readOnly?.writeTextFile).toBeUndefined();
  });

  it("sends the session id and absolute path on each request", async () => {
    const { conn, calls } = fakeConn();
    const host = createClientTextFileHost(conn, "s-42", { fs: { readTextFile: true, writeTextFile: true } });

    expect(await host?.readTextFile?.("/abs/file.ts")).toBe("from client");
    await host?.writeTextFile?.("/abs/file.ts", "next");

    expect(calls).toEqual([
      { method: "fs/read_text_file", params: { sessionId: "s-42", path: "/abs/file.ts" } },
      { method: "fs/write_text_file", params: { sessionId: "s-42", path: "/abs/file.ts", content: "next" } }
    ]);
  });
});

describe("acp server", () => {
  it("negotiates protocol version 1 and reports honest capabilities", async () => {
    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });

    const { response } = await awaitResponse(1);
    const result = response.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(1);
    const capabilities = result.agentCapabilities as Record<string, unknown>;
    expect(capabilities.loadSession).toBe(true);
    // CrewCoder takes images as on-disk paths, so the ACP image block stays off.
    expect((capabilities.promptCapabilities as Record<string, unknown>).image).toBe(false);
  });

  it("returns provider:model choice ids on session/new for the client model picker", async () => {
    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);

    await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const { response } = await awaitResponse(2);

    const models = (response.result as { models?: { availableModels: Array<{ modelId: string; name: string }> } }).models;
    expect(models?.availableModels.length).toBeGreaterThan(0);
    // Clients group the picker by the `provider:` prefix.
    expect(models?.availableModels.every((entry) => entry.modelId.includes(":"))).toBe(true);
  });

  it("accepts session/set_model even though the 1.x schema dropped the method", async () => {
    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);

    await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const sessionId = ((await awaitResponse(2)).response.result as { sessionId: string }).sessionId;

    await send({ jsonrpc: "2.0", id: 3, method: "session/set_model", params: { sessionId, modelId: "opencode:claude-sonnet-4-6" } });
    const { response } = await awaitResponse(3);
    expect(response.error).toBeUndefined();
  });

  it("accepts validated session-scoped external directories", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-root-"));
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-external-"));
    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);
    await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
    const sessionId = ((await awaitResponse(2)).response.result as { sessionId: string }).sessionId;

    await send({ jsonrpc: "2.0", id: 3, method: "session/set_external_directories", params: { sessionId, directories: [external] } });
    const { response } = await awaitResponse(3);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ externalDirectories: [external] });
  });

  it("persists replaced grants for an already-started ACP session", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-root-"));
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-external-"));
    const sessionId = createSessionId();
    await saveSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      cwd,
      requestedMode: "general",
      resolvedMode: "general",
      prompt: "existing",
      events: [],
      messages: [textMessage("user", "existing")],
      mutationLog: []
    });
    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);
    await send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId, cwd, mcpServers: [] } });
    await awaitResponse(2);

    await send({ jsonrpc: "2.0", id: 3, method: "session/set_external_directories", params: { sessionId, directories: [external] } });
    expect((await awaitResponse(3)).response.error).toBeUndefined();
    expect((await loadSessionRecord(sessionId)).externalDirectories).toEqual([external]);
  });

  it("rejects the filesystem root as an external directory", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-root-"));
    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);
    await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
    const sessionId = ((await awaitResponse(2)).response.result as { sessionId: string }).sessionId;

    await send({ jsonrpc: "2.0", id: 3, method: "session/set_external_directories", params: { sessionId, directories: [path.parse(cwd).root] } });
    expect((await awaitResponse(3)).response.error).toBeTruthy();
  });

  it("rejects an unknown ext method instead of silently accepting it", async () => {
    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);

    await send({ jsonrpc: "2.0", id: 2, method: "session/nonsense", params: {} });
    const { response } = await awaitResponse(2);
    expect(response.error).toBeTruthy();
  });

  it("creates a session and streams updates through a prompt turn", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-"));
    const { send, awaitResponse } = connect({ heuristic: true, approvalMode: "full-access", maxIterations: 1 });

    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);

    await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
    const created = await awaitResponse(2);
    const sessionId = (created.response.result as { sessionId: string }).sessionId;
    expect(sessionId).toBeTruthy();

    await send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "fix this React timeline resize bug" }] }
    });
    const turn = await awaitResponse(3);

    expect((turn.response.result as { stopReason: string }).stopReason).toBeTruthy();
    const updates = turn.notifications.filter((message) => message.method === "session/update");
    expect(updates.length).toBeGreaterThan(0);
    for (const update of updates) {
      expect((update.params as { sessionId: string }).sessionId).toBe(sessionId);
    }
  }, 30_000);

  it("replays a saved transcript as notifications on session/load", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-load-"));
    const sessionId = createSessionId();
    await saveSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      cwd,
      requestedMode: "general",
      resolvedMode: "general",
      prompt: "first question",
      events: [],
      messages: [textMessage("user", "first question"), assistantText("first answer")],
      mutationLog: []
    });

    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);

    await send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId, cwd, mcpServers: [] } });
    const { response, notifications } = await awaitResponse(2);
    expect(response.error).toBeUndefined();

    const replayed = notifications
      .filter((message) => message.method === "session/update")
      .map((message) => (message.params as { update: { sessionUpdate: string; content?: { text: string } } }).update);
    expect(replayed.map((update) => update.sessionUpdate)).toEqual(["user_message_chunk", "agent_message_chunk"]);
    expect(replayed[0].content?.text).toBe("first question");
    expect(replayed[1].content?.text).toBe("first answer");
  });

  it("reports an unknown session id on session/load rather than inventing one", async () => {
    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);

    await send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: "nope", cwd: "/tmp", mcpServers: [] } });
    const { response } = await awaitResponse(2);
    expect(response.error).toBeTruthy();
  });

  it("rejects a prompt for an unknown session instead of silently creating one", async () => {
    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);

    await send({
      jsonrpc: "2.0",
      id: 2,
      method: "session/prompt",
      params: { sessionId: "does-not-exist", prompt: [{ type: "text", text: "hello" }] }
    });
    const { response } = await awaitResponse(2);
    expect(response.error).toBeTruthy();
  });
});
