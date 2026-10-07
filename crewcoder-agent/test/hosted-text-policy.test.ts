import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import { CrewCoderAcpAgent } from "../src/acp/acp-agent.js";
import { hostedTextTools } from "../src/acp/hosted-text-tools.js";
import type { ModelInput } from "../src/core/model-client.js";
import { assistantText } from "../src/core/messages.js";

it("restricted new and resumed prompts route text to the host and reject every other tool", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hosted-policy-"));
  const reads: string[] = [], writes: string[] = [], inputs: ModelInput[] = [];
  fs.writeFileSync(path.join(dir, "private.png"), "LOCAL SECRET");
  let step = 0;
  const conn = {
    sessionUpdate: async () => undefined,
    readTextFile: async ({ path: file }: { path: string }) => { reads.push(file); return { content: "HOST TEXT" }; },
    writeTextFile: async ({ path: file }: { path: string }) => { writes.push(file); return {}; },
    requestPermission: async () => { throw new Error("Policy must not offer native execution approval"); }
  } as unknown as AgentSideConnection;
  const agent = new CrewCoderAcpAgent(conn, { approvalMode: "full-access", modelClient: {
    async complete(input) {
      inputs.push(input);
      if (step++ === 0) return {
        role: "assistant" as const, timestamp: 0, stopReason: "tool_calls" as const,
        content: [
          { type: "toolCall" as const, id: "read", name: "read", arguments: { path: "private.png" } },
          { type: "toolCall" as const, id: "write", name: "write", arguments: { path: "virtual-command.json", content: "{}" } },
          ...["bash", "grep", "delegateWorker", "extension_execution"].map(name => ({ type: "toolCall" as const, id: name, name, arguments: { command: "touch bypass" } }))
        ]
      };
      return assistantText("reviewed");
    }
  } });
  try {
    const initialized = await agent.initialize({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } });
    expect(initialized._meta?.["crewcoder/sessionToolPolicy"]).toMatchObject({ version: 1 });
    const session = await agent.newSession({ cwd: dir, mcpServers: [] });
    await agent.extMethod("session/set_tool_policy", { sessionId: session.sessionId, policy: "hosted-text-only", version: 1 });
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "Use hosted records" }] });
    await agent.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "Continue review" }] });
    expect(reads).toEqual([path.join(dir, "private.png")]);
    expect(writes).toEqual([path.join(dir, "virtual-command.json")]);
    expect(fs.existsSync(path.join(dir, "virtual-command.json"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "bypass"))).toBe(false);
    for (const input of inputs) {
      expect(input.availableTools.map(tool => tool.name)).toEqual(["read", "write"]);
      expect(input.useProviderNativeFileTools).toBe(false);
    }
    const results = inputs[1].messages.filter(message => message.role === "toolResult");
    expect(results.filter(message => message.role === "toolResult" && message.isError)).toHaveLength(4);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

it("requires both host methods and accepts only the versioned restrictive policy", async () => {
  expect(() => hostedTextTools(undefined)).toThrow(/requires both/);
  expect(() => hostedTextTools({ readTextFile: async () => "" })).toThrow(/requires both/);
  const agent = new CrewCoderAcpAgent({} as AgentSideConnection, { heuristic: true });
  await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const session = await agent.newSession({ cwd: process.cwd(), mcpServers: [] });
  await expect(agent.extMethod("session/set_tool_policy", { sessionId: session.sessionId, policy: "hosted-text-only", version: 1 })).rejects.toThrow(/requires both/);
  await expect(agent.extMethod("session/set_tool_policy", { sessionId: session.sessionId, policy: "unrestricted", version: 1 })).rejects.toThrow(/Invalid params/);
});
