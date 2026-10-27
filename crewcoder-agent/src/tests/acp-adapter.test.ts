import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nativeCatalog from "../providers/native-model-catalog.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAcpServer } from "../acp/acp-server.js";
import { CREWCODER_ARTIFACTS_META } from "../acp/artifacts.js";
import type { Artifact, ArtifactMetadata } from "../core/artifact-store.js";
import type { AcpAgentOptions } from "../acp/acp-agent.js";
import { translateEvent } from "../acp/event-translator.js";
import { toolKind, toolLocations, toolTitle } from "../acp/tool-kind.js";
import type { AgentEvent } from "../core/events.js";
import { assistantText, textMessage, type ToolResultMessage } from "../core/messages.js";
import { createSessionId, loadSessionRecord, saveSession } from "../core/session-store.js";
import type { ToolContext } from "../core/tool-types.js";
import { readTextFile, writeTextFile } from "../tools/text-file-io.js";
import { createClientTextFileHost } from "../acp/client-files.js";
import type { ModelClient, ModelInput } from "../core/model-client.js";
import { CLIENT_SYSTEM_PROMPT_HEADING, CLIENT_SYSTEM_PROMPT_MAX_CHARS, appendClientSystemPrompt } from "../core/system-prompt.js";
import { getText } from "../core/messages.js";
import { HOST_PROJECT_INSTRUCTIONS_MAX_CHARS } from "../core/host-project-instructions.js";
import type { AssistantMessage } from "../core/messages.js";

describe("ACP artifacts", () => {
  beforeEach(() => vi.stubEnv("CREWCODER_HOME", fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-artifacts-"))));
  afterEach(() => vi.unstubAllEnvs());

  async function open(modelClient = recordingModelClient(), approvalMode: AcpAgentOptions["approvalMode"] = "full-access") {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-artifact-workspace-"));
    const conn = connect({ modelClient, approvalMode, maxIterations: 4 });
    await conn.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } } });
    await conn.awaitResponse(1);
    await conn.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
    const sessionId = ((await conn.awaitResponse(2)).response.result as { sessionId: string }).sessionId;
    let requestId = 10;
    return {
      ...conn, sessionId, cwd,
      async request(method: string, params: Record<string, unknown> = {}) {
        const id = ++requestId;
        await conn.send({ jsonrpc: "2.0", id, method, params: { sessionId, version: 1, ...params } });
        return conn.awaitResponse(id);
      }
    };
  }

  it("lets an app list, create, download source, and edit artifacts with change notifications", async () => {
    const conn = await open();
    expect((await conn.request("session/artifacts/list")).response.result).toEqual({ artifacts: [] });
    const source = "<button onclick='this.textContent=42'>Calculate</button>";
    const created = await conn.request("session/artifacts/write", { title: "Calculator", format: "html", content: source });
    expect(created.response.error).toBeUndefined();
    const artifact = (created.response.result as { artifact: Artifact }).artifact;
    expect(artifact).toMatchObject({ content: source, revision: 1, mimeType: "text/html" });
    expect(created.notifications).toContainEqual({
      jsonrpc: "2.0", method: "_crewcoder/artifact_updated",
      params: { sessionId: conn.sessionId, version: 1, action: "created", artifact: expect.objectContaining({ id: artifact.id, revision: 1 }) }
    });
    expect((await conn.request("session/artifacts/read", { id: artifact.id })).response.result).toEqual({ artifact });
    const list = (await conn.request("session/artifacts/list")).response.result as { artifacts: ArtifactMetadata[] };
    expect(list.artifacts).toHaveLength(1);
    expect(list.artifacts[0]).not.toHaveProperty("content");
    const edited = await conn.request("session/artifacts/write", { id: artifact.id, expectedRevision: 1, title: "Calculator", format: "html", content: "edited source" });
    expect(edited.response.result).toMatchObject({ artifact: { revision: 2, content: "edited source" } });
    expect(edited.notifications[0]).toMatchObject({ method: "_crewcoder/artifact_updated", params: { action: "updated" } });
    const stale = await conn.request("session/artifacts/write", { id: artifact.id, expectedRevision: 1, title: "Calculator", format: "html", content: "stale edit" });
    expect(stale.response.error).toMatchObject({ data: { artifactCode: "conflict" } });
    expect(stale.notifications).toEqual([]);
    expect((await conn.request("session/artifacts/read", { id: artifact.id })).response.result).toMatchObject({ artifact: { content: "edited source" } });
  });

  it("validates wire input, session ownership, versions, and reserved tool names", async () => {
    const conn = await open();
    const created = await conn.request("session/artifacts/write", { title: "Diagram", format: "mermaid", content: "graph TD; A-->B" });
    const artifact = (created.response.result as { artifact: Artifact }).artifact;
    await conn.send({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: conn.cwd, mcpServers: [] } });
    const other = ((await conn.awaitResponse(3)).response.result as { sessionId: string }).sessionId;
    expect((await conn.request("session/artifacts/read", { sessionId: other, id: artifact.id })).response.error).toMatchObject({ data: { artifactCode: "not_found" } });
    expect((await conn.request("session/artifacts/read", { id: "../outside" })).response.error).toBeTruthy();
    expect((await conn.request("session/artifacts/list", { sessionId: "unknown" })).response.error).toBeTruthy();
    expect((await conn.request("session/artifacts/list", { version: 2 })).response.error).toBeTruthy();
    expect((await conn.request("session/artifacts/write", { title: "Bad", format: "exe", content: "" })).response.error).toBeTruthy();
    expect((await conn.request("session/set_client_tools", {
      tools: [{ name: "artifact_write", description: "shadow", inputSchema: { type: "object" } }]
    })).response.error).toBeTruthy();
  });

  it("offers model tools through the real loop and restores artifacts after reconnect and load", async () => {
    const client = recordingModelClient();
    client.complete = async (input) => {
      client.inputs.push(input);
      if (client.inputs.length > 1) return assistantText("Created the diagram");
      return {
        role: "assistant", stopReason: "tool_calls", timestamp: Date.now(),
        content: [{ type: "toolCall", id: "artifact-call", name: "artifact_write", arguments: { title: "Flow", format: "svg", content: "<svg xmlns='http://www.w3.org/2000/svg'><text>Flow</text></svg>" } }]
      };
    };
    const conn = await open(client);
    const turn = await conn.request("session/prompt", { prompt: [{ type: "text", text: "Create an artifact diagram" }] });
    expect(turn.response.error).toBeUndefined();
    expect(client.inputs[0]!.availableTools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["artifact_write", "artifact_read", "artifact_list"]));
    const change = turn.notifications.find((message) => message.method === "_crewcoder/artifact_updated");
    expect(change).toBeTruthy();
    const artifactId = ((change!.params as { artifact: ArtifactMetadata }).artifact).id;
    expect(client.inputs[1]!.messages.some((message) => message.role === "toolResult" && message.toolName === "artifact_write" && !message.isError)).toBe(true);
    expect(fs.readdirSync(conn.cwd)).toEqual([]);
    const reconnected = connect({ heuristic: true });
    await reconnected.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await reconnected.awaitResponse(1);
    await reconnected.send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId: conn.sessionId, cwd: conn.cwd, mcpServers: [] } });
    expect((await reconnected.awaitResponse(2)).response.error).toBeUndefined();
    await reconnected.send({ jsonrpc: "2.0", id: 3, method: "session/artifacts/read", params: { sessionId: conn.sessionId, version: 1, id: artifactId } });
    expect((await reconnected.awaitResponse(3)).response.result).toMatchObject({ artifact: { id: artifactId, format: "svg", revision: 1 } });
  }, 30_000);

  it("keeps artifact tools and writes outside the hosted-text-only policy", async () => {
    const client = recordingModelClient();
    const conn = await open(client);
    expect((await conn.request("session/set_tool_policy", { policy: "hosted-text-only" })).response.error).toBeUndefined();
    expect((await conn.request("session/artifacts/write", { title: "Blocked", format: "html", content: "" })).response.error).toBeTruthy();
    const turn = await conn.request("session/prompt", { prompt: [{ type: "text", text: "go" }] });
    expect(turn.response.error).toBeUndefined();
    expect(client.inputs[0]!.availableTools.map((tool) => tool.name).sort()).toEqual(["read", "write"]);
  }, 30_000);

  it("honors permission denial before a model can persist an artifact", async () => {
    const client = recordingModelClient();
    client.complete = async (input) => {
      client.inputs.push(input);
      return { role: "assistant", stopReason: "tool_calls", timestamp: Date.now(), content: [
        { type: "toolCall", id: "denied-artifact", name: "artifact_write", arguments: { title: "Blocked", format: "html", content: "blocked" } }
      ] };
    };
    const conn = await open(client, "review");
    await conn.send({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: conn.sessionId, prompt: [{ type: "text", text: "go" }] } });
    const observed: Record<string, unknown>[] = [];
    for (;;) {
      const message = await conn.next();
      if (message.id === 3 && !message.method) {
        expect(message.result).toMatchObject({ stopReason: "refusal" });
        break;
      }
      observed.push(message);
      if (message.method === "session/request_permission") await conn.send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: "reject_once" } } });
    }
    expect(observed.some((message) => message.method === "session/request_permission")).toBe(true);
    expect(observed.some((message) => message.method === "_crewcoder/artifact_updated")).toBe(false);
    expect((await conn.request("session/artifacts/list")).response.result).toEqual({ artifacts: [] });
  }, 30_000);
});

/** Records every model input so tests can assert what reached the system field versus the transcript. */
function recordingModelClient(): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    async complete(input) {
      inputs.push(input);
      return assistantText("recorded");
    }
  };
}

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
    expect(toolKind("TaskCreate")).toBe("think");
    expect(toolKind("TaskUpdate")).toBe("think");
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

  it("forwards tool result details including todo snapshots on rawOutput", () => {
    const result: ToolResultMessage = {
      ...toolResult("Created: Write the parser"),
      toolName: "TaskCreate",
      details: {
        todos: [
          { content: "Write the parser", status: "in_progress", activeForm: "Writing the parser" },
          { content: "Add tests", status: "pending" }
        ]
      }
    };
    const update = translateEvent({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "TaskCreate",
      result,
      isError: false
    });
    expect(update).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "completed",
      rawOutput: {
        output: "Created: Write the parser",
        isError: false,
        todos: [
          { content: "Write the parser", status: "in_progress", activeForm: "Writing the parser" },
          { content: "Add tests", status: "pending" }
        ]
      }
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

  it("publishes provider-native compaction on the same namespaced lifecycle", () => {
    expect(translateEvent({
      type: "provider_compaction",
      providerId: "codex",
      status: "started"
    })).toMatchObject({
      sessionUpdate: "_crewcoder/compaction_update",
      status: "started",
      automatic: true,
      message: expect.stringContaining("codex")
    });

    expect(translateEvent({
      type: "provider_compaction",
      providerId: "codex",
      status: "completed"
    })).toMatchObject({
      sessionUpdate: "_crewcoder/compaction_update",
      status: "completed",
      automatic: true,
      percent: 100
    });
  });

  it("marks host-requested compact as manual and includes the summary body", () => {
    const update = translateEvent({
      type: "session_compacted",
      compactionId: "compact-1",
      originalMessageCount: 24,
      retainedMessageCount: 8,
      summary: "host compact summary",
      automatic: false
    });
    expect(update).toEqual({
      sessionUpdate: "_crewcoder/compaction_update",
      status: "completed",
      automatic: false,
      percent: 100,
      message: "Context compacted. Continuing with the retained recent messages and summary.",
      compactionId: "compact-1",
      originalMessageCount: 24,
      retainedMessageCount: 8,
      summary: "host compact summary"
    });
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
    expect(result._meta).toEqual({
      "crewcoder/sessionCompact": { method: "session/compact", preview: true, editedSummary: true },
      "crewcoder/sessionSystemPrompt": { method: "session/set_system_prompt", maxChars: CLIENT_SYSTEM_PROMPT_MAX_CHARS, persisted: false },
      "crewcoder/projectInstructions": { method: "session/set_project_instructions", version: 1, files: ["AGENTS.md"], maxChars: HOST_PROJECT_INSTRUCTIONS_MAX_CHARS, persisted: false },
      "crewcoder/instructionPolicy": { method: "session/set_instruction_policy", version: 1, globalSources: ["codex-agents", "claude-md"], persisted: false },
      "crewcoder/sessionToolPolicy": { method: "session/set_tool_policy", version: 1, policies: ["hosted-text-only"] },
      "crewcoder/clientTools": { method: "session/set_client_tools", callMethod: "crewcoder/client_tool/call", version: 1, maxTools: 32 },
      "crewcoder/artifacts": CREWCODER_ARTIFACTS_META
    });
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

  it("includes newly discovered native models in the ACP picker", async () => {
    const discovery = vi.spyOn(nativeCatalog, "hydrateNativeProviderModels").mockImplementation(async (provider) => provider.id === "claude"
      ? { ...provider, models: ["new-claude"], modelCatalog: [{ id: "new-claude" }], defaultModel: "new-claude" }
      : provider);
    try {
      const { send, awaitResponse } = connect({ heuristic: true });
      await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
      await awaitResponse(1);
      await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
      const { response } = await awaitResponse(2);
      const result = response.result as { models: { availableModels: Array<{ modelId: string; name: string }> } };
      expect(result.models.availableModels).toContainEqual({ modelId: "claude:new-claude", name: "claude / new-claude" });
    } finally {
      discovery.mockRestore();
    }
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

  it("updates approval mode per session so clients can enable full access", async () => {
    const { send, awaitResponse } = connect({ heuristic: true, approvalMode: "review" });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);

    await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const sessionId = ((await awaitResponse(2)).response.result as { sessionId: string }).sessionId;

    await send({ jsonrpc: "2.0", id: 3, method: "session/set_approval_mode", params: { sessionId, approvalMode: "full-access" } });
    expect((await awaitResponse(3)).response).toMatchObject({ result: { approvalMode: "full-access" } });

    await send({ jsonrpc: "2.0", id: 4, method: "session/set_approval_mode", params: { sessionId, approvalMode: "unrestricted" } });
    expect((await awaitResponse(4)).response.error).toBeDefined();
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

  it("does not replay the previous turn as live updates on the next prompt", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-next-"));
    const { send, awaitResponse } = connect({ heuristic: true, approvalMode: "full-access", maxIterations: 1 });

    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);
    await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
    const sessionId = ((await awaitResponse(2)).response.result as { sessionId: string }).sessionId;

    await send({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "first unique question" }] }
    });
    const first = await awaitResponse(3);
    const firstText = first.notifications
      .filter((message) => message.method === "session/update")
      .map((message) => (message.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update)
      .filter((update) => update?.sessionUpdate === "agent_message_chunk")
      .map((update) => update?.content?.text ?? "")
      .join("");
    expect(firstText).toContain("CrewCoder loop is wired and ready.");

    await send({
      jsonrpc: "2.0",
      id: 4,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "second unique question" }] }
    });
    const second = await awaitResponse(4);
    const secondChunks = second.notifications
      .filter((message) => message.method === "session/update")
      .map((message) => (message.params as { update?: { sessionUpdate?: string; content?: { text?: string } } }).update);
    expect(secondChunks.some((update) => update?.sessionUpdate === "user_message_chunk")).toBe(false);
    const secondText = secondChunks
      .filter((update) => update?.sessionUpdate === "agent_message_chunk")
      .map((update) => update?.content?.text ?? "")
      .join("");
    expect(secondText).toContain("CrewCoder loop is wired and ready.");
    expect(secondText.split("CrewCoder loop is wired and ready.").length - 1).toBe(1);
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

  it("compacts a loaded durable session through session/compact and returns the summary", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-compact-"));
    const sessionId = createSessionId();
    const messages = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? textMessage("user", `user ${i}`) : assistantText(`assistant ${i}`)));
    await saveSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      cwd,
      requestedMode: "general",
      resolvedMode: "general",
      prompt: "user 0",
      events: [],
      messages,
      mutationLog: [],
      providerSessionIds: { codex: "stale-thread" }
    });

    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);
    await send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId, cwd, mcpServers: [] } });
    await awaitResponse(2);

    await send({ jsonrpc: "2.0", id: 3, method: "session/compact", params: { sessionId } });
    const { response, notifications } = await awaitResponse(3);
    expect(response.error).toBeUndefined();
    const result = response.result as {
      compacted: boolean;
      summary: string;
      originalMessageCount: number;
      retainedMessageCount: number;
      compactionId: string;
    };
    expect(result.compacted).toBe(true);
    expect(result.originalMessageCount).toBe(20);
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.compactionId).toBeTruthy();

    const updates = notifications
      .filter((message) => message.method === "session/update")
      .map((message) => (message.params as { update: { sessionUpdate: string; automatic?: boolean; summary?: string; status?: string } }).update)
      .filter((update) => update.sessionUpdate === "_crewcoder/compaction_update");
    expect(updates.some((update) => update.status === "started" && update.automatic === false)).toBe(true);
    const completed = updates.find((update) => update.status === "completed" && update.summary);
    expect(completed?.automatic).toBe(false);
    expect(completed?.summary).toBe(result.summary);

    const stored = await loadSessionRecord(sessionId);
    expect(stored.messages.length).toBeLessThan(20);
    expect(stored.providerSessionIds).toEqual({});
    expect(stored.compactions?.some((entry) => entry.id === result.compactionId)).toBe(true);
  });

  it("previews compaction without rewriting the saved session", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-compact-preview-"));
    const sessionId = createSessionId();
    const messages = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? textMessage("user", `user ${i}`) : assistantText(`assistant ${i}`)));
    await saveSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      cwd,
      requestedMode: "general",
      resolvedMode: "general",
      prompt: "user 0",
      events: [],
      messages,
      mutationLog: []
    });

    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);
    await send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId, cwd, mcpServers: [] } });
    await awaitResponse(2);

    await send({ jsonrpc: "2.0", id: 3, method: "session/compact", params: { sessionId, preview: true } });
    const { response } = await awaitResponse(3);
    expect(response.result).toMatchObject({ compacted: false, preview: true });
    expect(((response.result as { summary: string }).summary).length).toBeGreaterThan(0);
    expect((await loadSessionRecord(sessionId)).messages).toHaveLength(20);
  });

  it("applies a host-edited summary from session/compact", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-compact-edit-"));
    const sessionId = createSessionId();
    const messages = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? textMessage("user", `user ${i}`) : assistantText(`assistant ${i}`)));
    await saveSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      cwd,
      requestedMode: "general",
      resolvedMode: "general",
      prompt: "user 0",
      events: [],
      messages,
      mutationLog: []
    });

    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);
    await send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId, cwd, mcpServers: [] } });
    await awaitResponse(2);

    await send({ jsonrpc: "2.0", id: 3, method: "session/compact", params: { sessionId, summary: "Keep the auth rewrite and skip the abandoned cache branch." } });
    const { response } = await awaitResponse(3);
    expect(response.result).toMatchObject({ compacted: true, edited: true, summary: "Keep the auth rewrite and skip the abandoned cache branch." });
    const stored = await loadSessionRecord(sessionId);
    expect(stored.messages[0] && "content" in stored.messages[0] ? stored.messages[0] : undefined).toBeTruthy();
    expect(JSON.stringify(stored.messages[0])).toContain("Keep the auth rewrite and skip the abandoned cache branch.");
  });

  it("returns compacted false when the loaded session is too small to compact", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-compact-small-"));
    const sessionId = createSessionId();
    await saveSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      cwd,
      requestedMode: "general",
      resolvedMode: "general",
      prompt: "hello",
      events: [],
      messages: [textMessage("user", "hello"), assistantText("hi")],
      mutationLog: []
    });

    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);
    await send({ jsonrpc: "2.0", id: 2, method: "session/load", params: { sessionId, cwd, mcpServers: [] } });
    await awaitResponse(2);

    await send({ jsonrpc: "2.0", id: 3, method: "session/compact", params: { sessionId } });
    const { response } = await awaitResponse(3);
    expect(response.result).toMatchObject({ compacted: false, originalMessageCount: 2 });
    expect((await loadSessionRecord(sessionId)).messages).toHaveLength(2);
  });

  it("rejects session/compact on a session that has not been persisted yet", async () => {
    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);
    await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } });
    const sessionId = ((await awaitResponse(2)).response.result as { sessionId: string }).sessionId;

    await send({ jsonrpc: "2.0", id: 3, method: "session/compact", params: { sessionId } });
    expect((await awaitResponse(3)).response.error).toBeTruthy();
  });
});

describe("host system prompt", () => {
  it("appends the host prompt under a precedence heading and ignores blanks", () => {
    expect(appendClientSystemPrompt("base", "  ")).toBe("base");
    expect(appendClientSystemPrompt("base", undefined)).toBe("base");
    expect(appendClientSystemPrompt("base", " You are Nova. ")).toBe(`base\n\n${CLIENT_SYSTEM_PROMPT_HEADING}\n\nYou are Nova.`);
  });

  async function openSession(client: ModelClient) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-sysprompt-"));
    const conn = connect({ approvalMode: "full-access", maxIterations: 1, modelClient: client });
    await conn.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await conn.awaitResponse(1);
    await conn.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
    const sessionId = ((await conn.awaitResponse(2)).response.result as { sessionId: string }).sessionId;
    return { ...conn, sessionId };
  }

  it("delivers the host prompt in the system field on every turn without storing it in the transcript", async () => {
    const client = recordingModelClient();
    const { send, awaitResponse, sessionId } = await openSession(client);
    const identity = "You are Nova, the Supervisor. IDENTITY-MARKER-7f3a";

    await send({ jsonrpc: "2.0", id: 3, method: "session/set_system_prompt", params: { sessionId, systemPrompt: identity } });
    expect((await awaitResponse(3)).response.result).toEqual({ applied: true, length: identity.length, appliesTo: "next_prompt" });

    await send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "first turn" }] } });
    await awaitResponse(4);
    await send({ jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "second turn" }] } });
    await awaitResponse(5);

    expect(client.inputs.length).toBe(2);
    for (const input of client.inputs) {
      expect(input.systemPrompt).toContain(CLIENT_SYSTEM_PROMPT_HEADING);
      expect(input.systemPrompt).toContain(identity);
      expect(input.messages.some((message) => getText(message).includes("IDENTITY-MARKER-7f3a"))).toBe(false);
    }
    const secondTurnUserText = client.inputs[1]!.messages.filter((message) => message.role === "user").map(getText);
    // CrewCoder appends its own session background to the first user turn; the host prompt must not appear there.
    expect(secondTurnUserText).toHaveLength(2);
    expect(secondTurnUserText[0]!.startsWith("first turn")).toBe(true);
    expect(secondTurnUserText[1]).toBe("second turn");
  }, 30_000);

  it("replaces and clears the host prompt between turns", async () => {
    const client = recordingModelClient();
    const { send, awaitResponse, sessionId } = await openSession(client);

    await send({ jsonrpc: "2.0", id: 3, method: "session/set_system_prompt", params: { sessionId, systemPrompt: "version-one" } });
    await awaitResponse(3);
    await send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "a" }] } });
    await awaitResponse(4);
    await send({ jsonrpc: "2.0", id: 5, method: "session/set_system_prompt", params: { sessionId, systemPrompt: "version-two" } });
    await awaitResponse(5);
    await send({ jsonrpc: "2.0", id: 6, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "b" }] } });
    await awaitResponse(6);
    await send({ jsonrpc: "2.0", id: 7, method: "session/set_system_prompt", params: { sessionId, systemPrompt: "" } });
    await awaitResponse(7);
    await send({ jsonrpc: "2.0", id: 8, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "c" }] } });
    await awaitResponse(8);

    const [first, second, third] = client.inputs.map((input) => input.systemPrompt);
    expect(first).toContain("version-one");
    expect(second).toContain("version-two");
    expect(second).not.toContain("version-one");
    expect(third).not.toContain(CLIENT_SYSTEM_PROMPT_HEADING);
  }, 30_000);

  it("rejects non-string and oversized host prompts", async () => {
    const { send, awaitResponse, sessionId } = await openSession(recordingModelClient());

    await send({ jsonrpc: "2.0", id: 3, method: "session/set_system_prompt", params: { sessionId, systemPrompt: 42 } });
    expect((await awaitResponse(3)).response.error).toBeTruthy();
    await send({ jsonrpc: "2.0", id: 4, method: "session/set_system_prompt", params: { sessionId, systemPrompt: "x".repeat(CLIENT_SYSTEM_PROMPT_MAX_CHARS + 1) } });
    expect((await awaitResponse(4)).response.error).toBeTruthy();
    await send({ jsonrpc: "2.0", id: 5, method: "session/set_system_prompt", params: { sessionId: "missing", systemPrompt: "x" } });
    expect((await awaitResponse(5)).response.error).toBeTruthy();
  });
});

describe("acp instruction policy", () => {
  const WORKER_MARKER = "the active worker for this CrewCoder instance";
  let previousHomes: { codex?: string; claude?: string };
  let codexHome: string;
  let claudeHome: string;

  beforeEach(() => {
    previousHomes = { codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-codex-home-"));
    claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-claude-home-"));
    fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "CODEX-GLOBAL-MARKER");
    fs.writeFileSync(path.join(claudeHome, "CLAUDE.md"), "CLAUDE-GLOBAL-MARKER\n\n@RTK.md\n\n```\n@IGNORED.md\n```\nmail me@NOPE.md");
    fs.writeFileSync(path.join(claudeHome, "RTK.md"), "RTK-IMPORT-MARKER");
    fs.writeFileSync(path.join(claudeHome, "IGNORED.md"), "FENCED-IMPORT-MARKER");
    process.env.CODEX_HOME = codexHome;
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
  });

  afterEach(() => {
    if (previousHomes.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHomes.codex;
    if (previousHomes.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousHomes.claude;
  });

  async function turnWith(options: { modelId: string; policy?: { workerIdentity: boolean; globalInstructions: boolean }; hosted?: boolean }): Promise<string> {
    const client = recordingModelClient();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-policy-"));
    const { send, awaitResponse } = connect({ approvalMode: "full-access", maxIterations: 1, modelClient: client });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: options.hosted ? { fs: { readTextFile: true, writeTextFile: true } } : {} } });
    await awaitResponse(1);
    await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
    const sessionId = ((await awaitResponse(2)).response.result as { sessionId: string }).sessionId;
    await send({ jsonrpc: "2.0", id: 3, method: "session/set_model", params: { sessionId, modelId: options.modelId } });
    await awaitResponse(3);
    if (options.hosted) {
      await send({ jsonrpc: "2.0", id: 4, method: "session/set_tool_policy", params: { sessionId, policy: "hosted-text-only", version: 1 } });
      expect((await awaitResponse(4)).response.error).toBeUndefined();
    }
    if (options.policy) {
      await send({ jsonrpc: "2.0", id: 5, method: "session/set_instruction_policy", params: { sessionId, ...options.policy } });
      expect((await awaitResponse(5)).response.result).toEqual({ applied: true, version: 1, ...options.policy, appliesTo: "next_prompt" });
    }
    await send({ jsonrpc: "2.0", id: 6, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "go" }] } });
    expect((await awaitResponse(6)).response.error).toBeUndefined();
    const input = client.inputs[0]!;
    expect(input.messages.some((message) => getText(message).includes("GLOBAL-MARKER"))).toBe(false);
    return input.systemPrompt ?? "";
  }

  it("defaults to no worker identity or global files without a policy", async () => {
    const prompt = await turnWith({ modelId: "openai:gpt-5.4" });
    expect(prompt).not.toContain(WORKER_MARKER);
    expect(prompt).not.toContain("GLOBAL-MARKER");
  }, 30_000);

  it("drops the worker identity when the host turns it off", async () => {
    const prompt = await turnWith({ modelId: "openai:gpt-5.4", policy: { workerIdentity: false, globalInstructions: false } });
    expect(prompt).not.toContain(WORKER_MARKER);
    expect(prompt).not.toContain("Worker identity (IDENTITY.md)");
  }, 30_000);

  it("adds both global files with Claude imports when enabled", async () => {
    const prompt = await turnWith({ modelId: "openai:gpt-5.4", policy: { workerIdentity: true, globalInstructions: true } });
    expect(prompt).toContain("Global user instructions:");
    expect(prompt).toContain("CODEX-GLOBAL-MARKER");
    expect(prompt).toContain("CLAUDE-GLOBAL-MARKER");
    expect(prompt).toContain("RTK-IMPORT-MARKER");
    expect(prompt).not.toContain("FENCED-IMPORT-MARKER");
  }, 30_000);

  it("skips the Codex global file for codex-cli, which loads it itself", async () => {
    const prompt = await turnWith({ modelId: "codex-cli:gpt-5.4", policy: { workerIdentity: true, globalInstructions: true } });
    expect(prompt).not.toContain("CODEX-GLOBAL-MARKER");
    expect(prompt).toContain("CLAUDE-GLOBAL-MARKER");
  }, 30_000);

  it("gives hosted Supervisor-style sessions the global files when enabled", async () => {
    expect(await turnWith({ modelId: "openai:gpt-5.4", hosted: true })).not.toContain("GLOBAL-MARKER");
    const prompt = await turnWith({ modelId: "openai:gpt-5.4", hosted: true, policy: { workerIdentity: false, globalInstructions: true } });
    expect(prompt).toContain("CODEX-GLOBAL-MARKER");
    expect(prompt).toContain("RTK-IMPORT-MARKER");
  }, 30_000);

  it("rejects a policy without both booleans", async () => {
    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);
    await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: os.tmpdir(), mcpServers: [] } });
    const sessionId = ((await awaitResponse(2)).response.result as { sessionId: string }).sessionId;
    await send({ jsonrpc: "2.0", id: 3, method: "session/set_instruction_policy", params: { sessionId, workerIdentity: "no", globalInstructions: true } });
    expect((await awaitResponse(3)).response.error).toBeTruthy();
    await send({ jsonrpc: "2.0", id: 4, method: "session/set_instruction_policy", params: { sessionId, workerIdentity: false } });
    expect((await awaitResponse(4)).response.error).toBeTruthy();
  });
});

describe("acp host project instructions", () => {
  const AGENTS_TEXT = "<PROJECT_AGENTS.md>PROJECT-RULES-MARKER</PROJECT_AGENTS.md>";

  async function turnWith(modelId: string, setup?: (cwd: string) => void): Promise<string> {
    const client = recordingModelClient();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-project-"));
    setup?.(cwd);
    const { send, awaitResponse } = connect({ approvalMode: "full-access", maxIterations: 1, modelClient: client });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);
    await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
    const sessionId = ((await awaitResponse(2)).response.result as { sessionId: string }).sessionId;
    await send({ jsonrpc: "2.0", id: 3, method: "session/set_model", params: { sessionId, modelId } });
    await awaitResponse(3);
    await send({ jsonrpc: "2.0", id: 4, method: "session/set_system_prompt", params: { sessionId, systemPrompt: "HOST-IDENTITY" } });
    await awaitResponse(4);
    await send({ jsonrpc: "2.0", id: 5, method: "session/set_project_instructions", params: { sessionId, instructions: [{ file: "AGENTS.md", text: AGENTS_TEXT }] } });
    expect((await awaitResponse(5)).response.result).toEqual({ applied: true, count: 1, appliesTo: "next_prompt" });
    await send({ jsonrpc: "2.0", id: 6, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "go" }] } });
    await awaitResponse(6);
    const input = client.inputs[0]!;
    expect(input.messages.some((message) => getText(message).includes("PROJECT-RULES-MARKER"))).toBe(false);
    expect(input.systemPrompt).toContain("HOST-IDENTITY");
    return input.systemPrompt ?? "";
  }

  it("keeps the host AGENTS.md for providers that do not load it themselves", async () => {
    expect(await turnWith("openai:gpt-5.4")).toContain("PROJECT-RULES-MARKER");
    expect(await turnWith("codex:gpt-5.4")).toContain("PROJECT-RULES-MARKER");
  }, 30_000);

  it("drops the host AGENTS.md for codex-cli, which reads it from the workspace", async () => {
    expect(await turnWith("codex-cli:gpt-5.4")).not.toContain("PROJECT-RULES-MARKER");
  }, 30_000);

  it("drops it for Claude only when the project CLAUDE.md imports AGENTS.md", async () => {
    expect(await turnWith("claude:claude-sonnet-5")).toContain("PROJECT-RULES-MARKER");
    expect(await turnWith("claude:claude-sonnet-5", (cwd) => fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "# Claude\n@AGENTS.md\n"))).not.toContain("PROJECT-RULES-MARKER");
    expect(await turnWith("claude:claude-sonnet-5", (cwd) => {
      fs.mkdirSync(path.join(cwd, ".claude"));
      fs.writeFileSync(path.join(cwd, ".claude", "CLAUDE.md"), "@../AGENTS.md");
    })).not.toContain("PROJECT-RULES-MARKER");
    // An email address or prose mention is not an import.
    expect(await turnWith("claude:claude-sonnet-5", (cwd) => fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "See me@AGENTS.md for details."))).toContain("PROJECT-RULES-MARKER");
  }, 60_000);

  it("rejects unknown files, duplicates, non-strings, and oversized instructions", async () => {
    const { send, awaitResponse } = connect({ heuristic: true });
    await send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await awaitResponse(1);
    await send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: os.tmpdir(), mcpServers: [] } });
    const sessionId = ((await awaitResponse(2)).response.result as { sessionId: string }).sessionId;
    const bad = [
      "AGENTS.md",
      [{ file: "../secrets.md", text: "x" }],
      [{ file: "AGENTS.md", text: 1 }],
      [{ file: "AGENTS.md", text: "a" }, { file: "AGENTS.md", text: "b" }],
      [{ file: "AGENTS.md", text: "x".repeat(HOST_PROJECT_INSTRUCTIONS_MAX_CHARS + 1) }]
    ];
    for (const [index, instructions] of bad.entries()) {
      await send({ jsonrpc: "2.0", id: 10 + index, method: "session/set_project_instructions", params: { sessionId, instructions } });
      expect((await awaitResponse(10 + index)).response.error, JSON.stringify(instructions).slice(0, 60)).toBeTruthy();
    }
    await send({ jsonrpc: "2.0", id: 20, method: "session/set_project_instructions", params: { sessionId, instructions: [] } });
    expect((await awaitResponse(20)).response.result).toEqual({ applied: true, count: 0, appliesTo: "next_prompt" });
  });
});

describe("acp client tools", () => {
  const demoTool = { name: "crew_demo", description: "Host-executed demo tool.", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } };

  /** First turn calls the host tool once, then answers; records every model input. */
  function scriptedClient(): ModelClient & { inputs: ModelInput[] } {
    const inputs: ModelInput[] = [];
    return {
      inputs,
      async complete(input) {
        inputs.push(input);
        if (inputs.length > 1) return assistantText("done");
        const call: AssistantMessage = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "crew_demo", arguments: { q: "tasks" } }], stopReason: "tool_calls", timestamp: Date.now() };
        return call;
      }
    };
  }

  async function open(client: ModelClient) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-acp-client-tools-"));
    const conn = connect({ approvalMode: "full-access", maxIterations: 4, modelClient: client });
    await conn.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
    await conn.awaitResponse(1);
    await conn.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd, mcpServers: [] } });
    const sessionId = ((await conn.awaitResponse(2)).response.result as { sessionId: string }).sessionId;
    return { ...conn, sessionId };
  }

  /** Runs a prompt, answering each host tool call with `answer`, and returns the calls seen. */
  async function promptWithHost(conn: Awaited<ReturnType<typeof open>>, id: number, answer: (params: Record<string, unknown>) => Record<string, unknown>) {
    const calls: Record<string, unknown>[] = [];
    await conn.send({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: conn.sessionId, prompt: [{ type: "text", text: "go" }] } });
    for (;;) {
      const message = await conn.next();
      if (message.id === id && !message.method) return { calls, response: message };
      if (message.method === "crewcoder/client_tool/call") {
        const params = message.params as Record<string, unknown>;
        calls.push(params);
        await conn.send({ jsonrpc: "2.0", id: message.id, result: answer(params) });
      }
    }
  }

  it("routes a model call to the host and returns the host result to the model", async () => {
    const client = scriptedClient();
    const conn = await open(client);
    await conn.send({ jsonrpc: "2.0", id: 3, method: "session/set_client_tools", params: { sessionId: conn.sessionId, version: 1, tools: [demoTool] } });
    expect((await conn.awaitResponse(3)).response.result).toEqual({ applied: true, version: 1, count: 1 });

    const { calls, response } = await promptWithHost(conn, 4, () => ({ content: [{ type: "text", text: "host-result-42" }] }));
    expect(response.error).toBeUndefined();
    expect(calls).toEqual([{ sessionId: conn.sessionId, name: "crew_demo", arguments: { q: "tasks" } }]);
    expect(client.inputs[0]!.availableTools.map((tool) => tool.name)).toContain("crew_demo");
    const toolResult = client.inputs[1]!.messages.find((message) => message.role === "toolResult");
    expect(toolResult && getText(toolResult)).toBe("host-result-42");
    expect((toolResult as ToolResultMessage).isError).toBe(false);
  }, 30_000);

  it("reports a host error to the model as a failed tool result", async () => {
    const client = scriptedClient();
    const conn = await open(client);
    await conn.send({ jsonrpc: "2.0", id: 3, method: "session/set_client_tools", params: { sessionId: conn.sessionId, version: 1, tools: [demoTool] } });
    await conn.awaitResponse(3);
    await promptWithHost(conn, 4, () => ({ content: [{ type: "text", text: "tasks write access is not granted" }], isError: true }));
    const toolResult = client.inputs[1]!.messages.find((message) => message.role === "toolResult") as ToolResultMessage;
    expect(toolResult.isError).toBe(true);
    expect(getText(toolResult)).toBe("tasks write access is not granted");
  }, 30_000);

  it("keeps host tools available under the hosted-text-only policy", async () => {
    const client = scriptedClient();
    const conn = await open(client);
    // Hosted policy needs both client filesystem capabilities, so this session re-initializes with them.
    await conn.send({ jsonrpc: "2.0", id: 10, method: "initialize", params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } } });
    await conn.awaitResponse(10);
    await conn.send({ jsonrpc: "2.0", id: 11, method: "session/set_tool_policy", params: { sessionId: conn.sessionId, policy: "hosted-text-only", version: 1 } });
    await conn.awaitResponse(11);
    await conn.send({ jsonrpc: "2.0", id: 12, method: "session/set_client_tools", params: { sessionId: conn.sessionId, version: 1, tools: [demoTool] } });
    await conn.awaitResponse(12);
    const { calls } = await promptWithHost(conn, 13, () => ({ content: "ok" }));
    expect(calls).toHaveLength(1);
    expect(client.inputs[0]!.availableTools.map((tool) => tool.name).sort()).toEqual(["crew_demo", "read", "write"]);
  }, 30_000);

  it("rejects tools that shadow built-ins, use unsupported schema keywords, or a wrong version", async () => {
    const conn = await open(scriptedClient());
    const attempt = async (id: number, params: Record<string, unknown>) => {
      await conn.send({ jsonrpc: "2.0", id, method: "session/set_client_tools", params: { sessionId: conn.sessionId, version: 1, ...params } });
      return (await conn.awaitResponse(id)).response;
    };
    expect((await attempt(3, { tools: [{ ...demoTool, name: "read" }] })).error).toBeTruthy();
    expect((await attempt(4, { tools: [{ ...demoTool, inputSchema: { type: "object", properties: { q: { oneOf: [] } } } }] })).error).toBeTruthy();
    expect((await attempt(5, { tools: [demoTool, demoTool] })).error).toBeTruthy();
    expect((await attempt(6, { version: 2, tools: [demoTool] })).error).toBeTruthy();
    expect((await attempt(7, { tools: [{ ...demoTool, inputSchema: { type: "string" } }] })).error).toBeTruthy();
    expect((await attempt(8, { tools: [] })).result).toEqual({ applied: true, version: 1, count: 0 });
  });
});
