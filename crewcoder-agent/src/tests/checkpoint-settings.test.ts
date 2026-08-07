import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentLoop } from "../core/agent-loop.js";
import { readConfig, setConfigValue } from "../core/config.js";
import { assistantText, getText, type AgentMessage } from "../core/messages.js";
import type { ModelClient } from "../core/model-client.js";
import type { ToolDefinition } from "../core/tool-types.js";

const originalCrewCoderHome = process.env.CREWCODER_HOME;

afterEach(() => {
  if (originalCrewCoderHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalCrewCoderHome;
});

describe("checkpoint settings", () => {
  it("keeps automatic checkpoints enabled for existing configs", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-checkpoint-config-"));
    process.env.CREWCODER_HOME = home;
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ defaultProvider: "codex" }), "utf8");

    expect(readConfig().checkpointsEnabled).toBe(true);
    expect(setConfigValue("checkpointsEnabled", "false").checkpointsEnabled).toBe(false);
    expect(readConfig().checkpointsEnabled).toBe(false);
  });

  it("skips snapshots and checkpoint events when disabled", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-checkpoint-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-checkpoint-workspace-"));
    process.env.CREWCODER_HOME = home;
    setConfigValue("checkpointsEnabled", "false");

    const mutate: ToolDefinition = {
      name: "mutate",
      description: "Mutate a workspace file",
      isMutation: true,
      parse: (args) => args,
      async execute() {
        fs.writeFileSync(path.join(cwd, "changed.txt"), "changed", "utf8");
        return { content: [{ type: "text", text: "mutated" }] };
      }
    };
    const modelClient: ModelClient = {
      async complete(input) {
        const mutated = input.messages.some((message) => message.role === "toolResult" && getText(message as AgentMessage) === "mutated");
        if (mutated) return assistantText("done");
        return {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_mutate", name: "mutate", arguments: {} }],
          stopReason: "tool_calls",
          timestamp: Date.now()
        };
      }
    };
    const events: string[] = [];

    const result = await runAgentLoop({ prompt: "mutate", requestedMode: "general", cwd }, {
      maxIterations: 2,
      approvalMode: "full-access",
      tools: [mutate],
      modelClient,
      persistSession: false,
      emit: (event) => { events.push(event.type); }
    });

    expect(fs.readFileSync(path.join(cwd, "changed.txt"), "utf8")).toBe("changed");
    expect(result.checkpoints).toEqual([]);
    expect(events).not.toContain("checkpoint_created");
  });
});
