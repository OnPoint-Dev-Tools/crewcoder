import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../core/agent-loop.js";
import { assistantText, getText, type AssistantMessage } from "../core/messages.js";
import type { ModelClient, ModelInput } from "../core/model-client.js";
import { buildSystemPrompt } from "../core/system-prompt.js";
import { createToolRegistry } from "../tools/index.js";
import {
  applyIncomingUserMessage,
  crewcoderMutationBlockReason,
  emptyCrewcoderWorkflow,
  isPlanApprovalMessage,
  isReadOnlyDiscoveryCommand,
  reconstructCrewcoderWorkflow,
  recordClarification,
  recordProposedPlan
} from "../modes/crewcoder-workflow.js";
import { writeTool } from "../tools/write.js";

function toolCall(name: string, args: Record<string, unknown>, id = "tool-1"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    stopReason: "tool_calls",
    timestamp: Date.now()
  };
}

function scriptedClient(script: Array<AssistantMessage | ((input: ModelInput) => AssistantMessage)>): ModelClient {
  let turn = 0;
  return {
    async complete(input) {
      const next = script[Math.min(turn, script.length - 1)];
      turn += 1;
      if (!next) return assistantText("done");
      return typeof next === "function" ? next(input) : next;
    }
  };
}

describe("crewcoder mode", () => {
  it("requires clarification and approval before implementation", () => {
    const prompt = buildSystemPrompt({ mode: "crewcoder", skills: [], docs: [] });

    expect(prompt).toContain("CrewCoder Deliberate Workflow mode");
    expect(prompt).toContain("Always call crewcoder_clarify");
    expect(prompt).toContain("A request to implement made before crewcoder_propose_plan does not count as plan approval");
    expect(prompt).toContain("Implement only after approval");
    expect(prompt).toContain("runtime blocks edits");
  });

  it("distinguishes plan-only work and permits only read-only discovery before approval", () => {
    const prompt = buildSystemPrompt({ mode: "crewcoder", skills: [], docs: [] });

    expect(prompt).toContain("Never assume a plan-only request authorizes implementation");
    expect(prompt).toContain("run read-only discovery commands before approval");
    expect(prompt).toContain("Do not edit or create files");
  });

  it("uses core coding tools plus workflow tools without authoring-mode tools", () => {
    const names = createToolRegistry("crewcode", "crewcoder").map((tool) => tool.name);

    expect(names).toContain("read");
    expect(names).toContain("edit");
    expect(names).toContain("crewcoder_clarify");
    expect(names).toContain("crewcoder_propose_plan");
    expect(names).not.toContain("docs");
    expect(names).not.toContain("createPlugin");
    expect(names).not.toContain("createCrewCoderExtension");
    expect(createToolRegistry("standalone", "general").map((tool) => tool.name)).not.toContain("crewcoder_clarify");
  });

  it("runs as an explicit mode without injecting authoring knowledge", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-deliberate-mode-"));
    const result = await runAgentLoop(
      { prompt: "add a settings page", requestedMode: "crewcoder", cwd },
      { maxIterations: 1, persistSession: false }
    );

    expect(result.mode).toBe("crewcoder");
    expect(result.activatedSkills).toEqual([]);
    expect(result.retrievedDocs).toEqual([]);
    expect(result.notes.join(" ")).toContain("Runtime-enforced");
  });

  it("blocks writes until the plan is approved, even after the user answers a question", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-block-write-"));
    const result = await runAgentLoop(
      { prompt: "add a settings page", requestedMode: "crewcoder", cwd },
      {
        maxIterations: 1,
        persistSession: false,
        modelClient: scriptedClient([toolCall("write", { path: "settings.ts", content: "export const ok = true;\n" })])
      }
    );

    expect(fs.existsSync(path.join(cwd, "settings.ts"))).toBe(false);
    expect(result.mutationLog).toEqual([]);
    expect(getText(result.messages.find((message) => message.role === "toolResult")!)).toContain("blocked");
  });

  it("does not treat a clarification answer as plan approval", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-yes-is-not-approval-"));
    const result = await runAgentLoop(
      { prompt: "put it in src/settings.ts", requestedMode: "crewcoder", cwd },
      {
        maxIterations: 1,
        persistSession: false,
        initialCrewcoderWorkflow: recordClarification(emptyCrewcoderWorkflow(), ["Where should the page live?"]),
        modelClient: scriptedClient([toolCall("write", { path: "src/settings.ts", content: "export {}\n" })])
      }
    );

    expect(fs.existsSync(path.join(cwd, "src", "settings.ts"))).toBe(false);
    expect(getText(result.messages.find((message) => message.role === "toolResult")!)).toContain("crewcoder_propose_plan");
  });

  it("unlocks writes only after clarify, plan, and explicit approval", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-approved-write-"));
    const clarified = recordClarification(emptyCrewcoderWorkflow(), ["Use a page or a modal?"]);
    const planned = recordProposedPlan(applyIncomingUserMessage(clarified, "A settings page."), {
      requirements: "Add a settings page.",
      plan: "Write src/settings.ts",
      acceptanceCriteria: "File exists."
    });
    const result = await runAgentLoop(
      { prompt: "/approve-plan", requestedMode: "crewcoder", cwd },
      {
        maxIterations: 2,
        persistSession: false,
        initialCrewcoderWorkflow: planned,
        modelClient: scriptedClient([
          toolCall("write", { path: "src/settings.ts", content: "export const settings = true;\n" }),
          assistantText("done")
        ])
      }
    );

    expect(fs.existsSync(path.join(cwd, "src", "settings.ts"))).toBe(true);
    expect(result.mutationLog).toContain("src/settings.ts");
  });

  it("rejects propose_plan before clarification answers", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-plan-too-soon-"));
    const result = await runAgentLoop(
      { prompt: "add a settings page", requestedMode: "crewcoder", cwd },
      {
        maxIterations: 1,
        persistSession: false,
        modelClient: scriptedClient([toolCall("crewcoder_propose_plan", {
          requirements: "Add settings.",
          plan: "Write a file.",
          acceptanceCriteria: "It exists."
        })])
      }
    );

    expect(getText(result.messages.find((message) => message.role === "toolResult")!)).toContain("crewcoder_clarify");
  });

  it("allows read-only bash and blocks mutating bash before approval", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-bash-gate-"));
    fs.writeFileSync(path.join(cwd, "README.md"), "hello\n");
    const result = await runAgentLoop(
      { prompt: "inspect then mutate", requestedMode: "crewcoder", cwd },
      {
        maxIterations: 1,
        persistSession: false,
        modelClient: scriptedClient([{
          role: "assistant",
          content: [
            { type: "toolCall", id: "read-1", name: "bash", arguments: { command: "cat README.md" } },
            { type: "toolCall", id: "write-1", name: "bash", arguments: { command: "echo mutated > README.md" } }
          ],
          stopReason: "tool_calls",
          timestamp: Date.now()
        }])
      }
    );
    const results = result.messages.filter((message) => message.role === "toolResult");
    expect(getText(results[0]!)).toContain("hello");
    expect(getText(results[1]!)).toContain("blocked");
    expect(fs.readFileSync(path.join(cwd, "README.md"), "utf8")).toBe("hello\n");
  });

  it("keeps general mode unblocked", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-general-write-"));
    const result = await runAgentLoop(
      { prompt: "write a file", requestedMode: "general", cwd },
      {
        maxIterations: 2,
        persistSession: false,
        modelClient: scriptedClient([
          toolCall("write", { path: "ok.ts", content: "export const ok = 1;\n" }),
          assistantText("wrote it")
        ])
      }
    );
    expect(fs.existsSync(path.join(cwd, "ok.ts"))).toBe(true);
    expect(result.mutationLog).toContain("ok.ts");
  });
});

describe("crewcoder workflow helpers", () => {
  it("classifies plan approval tightly", () => {
    expect(isPlanApprovalMessage("/approve-plan")).toBe(true);
    expect(isPlanApprovalMessage("approve")).toBe(true);
    expect(isPlanApprovalMessage("lgtm")).toBe(true);
    expect(isPlanApprovalMessage("yes, but also add logging")).toBe(false);
    expect(isPlanApprovalMessage("put it in src/settings.ts")).toBe(false);
  });

  it("advances answers to awaiting_plan without unlocking mutations", () => {
    const answered = applyIncomingUserMessage(recordClarification(emptyCrewcoderWorkflow(), ["Where?"]), "src/");
    expect(answered.phase).toBe("awaiting_plan");
    expect(crewcoderMutationBlockReason(writeTool, { path: "src/a.ts", content: "x" }, answered)).toContain("crewcoder_propose_plan");
  });

  it("reconstructs approval from the transcript", () => {
    const state = reconstructCrewcoderWorkflow([
      { role: "user", content: [{ type: "text", text: "add settings" }], timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "crewcoder_clarify",
        content: [{ type: "text", text: "q" }],
        isError: false,
        timestamp: 2,
        details: { questions: ["Where?"] }
      },
      { role: "user", content: [{ type: "text", text: "src/" }], timestamp: 3 },
      {
        role: "toolResult",
        toolCallId: "p1",
        toolName: "crewcoder_propose_plan",
        content: [{ type: "text", text: "plan" }],
        isError: false,
        timestamp: 4,
        details: { requirements: "Add settings", plan: "Write src/settings.ts", acceptanceCriteria: "File exists" }
      },
      { role: "user", content: [{ type: "text", text: "/approve-plan" }], timestamp: 5 }
    ]);
    expect(state.phase).toBe("approved");
  });

  it("treats git status as read-only and redirects as mutations", () => {
    expect(isReadOnlyDiscoveryCommand("git status")).toBe(true);
    expect(isReadOnlyDiscoveryCommand("rg crewcoder src")).toBe(true);
    expect(isReadOnlyDiscoveryCommand("echo hi > file.ts")).toBe(false);
    expect(isReadOnlyDiscoveryCommand("npm install")).toBe(false);
  });
});
