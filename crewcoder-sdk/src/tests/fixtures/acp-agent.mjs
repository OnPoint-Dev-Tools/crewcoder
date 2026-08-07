import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const output = Writable.toWeb(process.stdout);
const input = Readable.toWeb(process.stdin);
let connection;
connection = new AgentSideConnection(() => ({
  async initialize(params) { return { protocolVersion: params.protocolVersion, agentCapabilities: { loadSession: true }, authMethods: [] }; },
  async authenticate() {},
  async newSession() { return { sessionId: "session_fixture" }; },
  async loadSession() { return {}; },
  async prompt(params) {
    await connection.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "fixture response" } } });
    return { stopReason: "end_turn" };
  },
  async cancel() {}
}), ndJsonStream(output, input));
