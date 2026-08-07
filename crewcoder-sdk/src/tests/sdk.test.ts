import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCrewCoderSession,
  type AgentEvent,
  type ModelClient,
  type ToolDefinition
} from "../index.js";

function temporaryWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-sdk-"));
}

describe("CrewCoder SDK", () => {
  it("runs an in-memory session and streams typed events", async () => {
    const events: AgentEvent[] = [];
    const modelClient: ModelClient = {
      async complete(_input, _signal, stream) {
        await stream?.onThinkingDelta?.("checking");
        await stream?.onAssistantDelta?.("hello");
        return {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
          stopReason: "end",
          timestamp: Date.now()
        };
      }
    };
    const session = createCrewCoderSession({
      cwd: temporaryWorkspace(),
      persistSession: false,
      modelClient
    });
    session.subscribe((event) => { events.push(event); });

    const result = await session.prompt("Say hello");

    expect(result.sessionFile).toBeUndefined();
    expect(session.sessionId).toBe(result.sessionId);
    expect(events.some((event) => event.type === "thinking_delta")).toBe(true);
    expect(events.some((event) => event.type === "assistant_delta")).toBe(true);
    expect(events.some((event) => event.type === "session_saved")).toBe(false);
  });

  it("continues an in-memory session across prompts", async () => {
    let turns = 0;
    const modelClient: ModelClient = {
      async complete() {
        turns += 1;
        return {
          role: "assistant",
          content: [{ type: "text", text: `turn ${turns}` }],
          stopReason: "end",
          timestamp: Date.now()
        };
      }
    };
    const session = createCrewCoderSession({ cwd: temporaryWorkspace(), persistSession: false, modelClient });

    const first = await session.prompt("first");
    const second = await session.prompt("second");

    expect(second.sessionId).toBe(first.sessionId);
    expect(second.messages.length).toBeGreaterThan(first.messages.length);
    expect(turns).toBe(2);
  });

  it("runs custom tools after a live SDK approval", async () => {
    let toolRan = false;
    let turns = 0;
    const customTool: ToolDefinition = {
      name: "sdk_mutation",
      description: "Perform a test mutation.",
      isMutation: true,
      parse: (args) => args,
      async execute() {
        toolRan = true;
        return { content: [{ type: "text", text: "changed" }] };
      }
    };
    const modelClient: ModelClient = {
      async complete() {
        turns += 1;
        if (turns === 1) {
          return {
            role: "assistant",
            content: [{ type: "toolCall", id: "sdk-tool-1", name: "sdk_mutation", arguments: {} }],
            stopReason: "tool_calls",
            timestamp: Date.now()
          };
        }
        return {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "end",
          timestamp: Date.now()
        };
      }
    };
    const session = createCrewCoderSession({
      cwd: temporaryWorkspace(),
      persistSession: false,
      approval: "review",
      customTools: [customTool],
      modelClient
    });
    session.subscribe((event) => {
      if (event.type === "approval_required") session.approve(event.approvalId, true, "SDK host approved");
    });

    const result = await session.prompt("Run the custom tool");

    expect(toolRan).toBe(true);
    expect(result.approvalDenied).toBeUndefined();
    expect(result.messages.some((message) => message.role === "toolResult" && message.toolName === "sdk_mutation")).toBe(true);
  });
});
