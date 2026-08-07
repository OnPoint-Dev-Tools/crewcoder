/**
 * Minimal ACP agent used by `acp-client-provider.test.ts`.
 *
 * It speaks real newline-delimited JSON-RPC on stdio so the provider is
 * exercised over the actual wire rather than against a mock. Behavior is
 * switched by CREWCODER_FAKE_ACP_MODE.
 */
import readline from "node:readline";

const mode = process.env.CREWCODER_FAKE_ACP_MODE ?? "ok";
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const update = (sessionId, update) => send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });

let clientCapabilities;
let requestId = 0;
const pending = new Map();

function ask(method, params) {
  const id = `agent-${++requestId}`;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);

  if (message.id !== undefined && message.method === undefined) {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message.result ?? { error: message.error });
    }
    return;
  }

  const { id, method, params } = message;

  if (method === "initialize") {
    clientCapabilities = params.clientCapabilities;
    reply(id, { protocolVersion: params.protocolVersion, agentInfo: { name: "fake-grok", version: "0.0.1" }, agentCapabilities: { loadSession: true } });
    return;
  }

  if (method === "session/new") {
    reply(id, { sessionId: "fake-session-1" });
    return;
  }

  if (method === "session/load") {
    if (mode === "load-fails") send({ jsonrpc: "2.0", id, error: { code: -32603, message: "unknown session" } });
    else reply(id, {});
    return;
  }

  if (method === "session/prompt") {
    const sessionId = params.sessionId;
    update(sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking hard" } });

    if (mode === "permission") {
      const outcome = await ask("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "call-1", title: "rm -rf /" },
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" }
        ]
      });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `outcome:${outcome.outcome?.optionId ?? outcome.outcome?.outcome}` } });
      reply(id, { stopReason: "end_turn" });
      return;
    }

    if (mode === "fs") {
      const readResult = await ask("fs/read_text_file", { sessionId, path: "acp-fixture.txt" });
      const escape = await ask("fs/write_text_file", { sessionId, path: "../../escaped.txt", content: "nope" });
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `read:${readResult.content}|escape:${escape.error ? "denied" : "allowed"}` } });
      reply(id, { stopReason: "end_turn" });
      return;
    }

    if (mode === "empty") {
      reply(id, { stopReason: "end_turn" });
      return;
    }

    if (mode === "refusal") {
      reply(id, { stopReason: "refusal" });
      return;
    }

    update(sessionId, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "read package.json", kind: "read", status: "in_progress", rawInput: { path: "package.json" } });
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "call-1", status: "completed", content: [{ type: "content", content: { type: "text", text: "file body" } }] });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " } });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "from Grok." } });
    // Echo the spawn argv so the provider's model/effort flag rendering is observable.
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ` argv:${process.argv.slice(2).join(",")}` } });
    update(sessionId, { sessionUpdate: "usage_update", used: 4321, size: 200000, cost: { amount: 9.99, currency: "USD" } });
    update(sessionId, { sessionUpdate: "session_info_update", title: "ignored" });
    reply(id, { stopReason: "end_turn", _meta: { caps: clientCapabilities } });
    return;
  }

  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `no such method ${method}` } });
});
