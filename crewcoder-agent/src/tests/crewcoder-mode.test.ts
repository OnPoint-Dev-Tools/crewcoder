import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../core/agent-loop.js";
import { loadSession } from "../core/session-loader.js";
import { assistantText, getText, type AssistantMessage, type ToolResultMessage } from "../core/messages.js";
import type { ModelClient, ModelInput } from "../core/model-client.js";
import { buildSystemPrompt } from "../core/system-prompt.js";
import { createToolRegistry } from "../tools/index.js";
import {
  applyIncomingUserMessage,
  crewcoderMutationBlockReason,
  emptyCrewcoderWorkflow,
  isPlanApprovalMessage,
  isReadOnlyDiscoveryCommand,
  formatCrewcoderWorkflowPrompt,
  recordCrewcoderInspection,
  reconstructCrewcoderWorkflow,
  recordClarification,
  recordProposedPlan
} from "../modes/crewcoder-workflow.js";
import { writeTool } from "../tools/write.js";
import { crewcoderProposePlanTool } from "../modes/crewcoder-tools.js";

const settingsPlan = {
  requirements: "Add a settings page.",
  investigation: "Read README.md: this project has no settings entry point. Follow its existing TypeScript export convention.",
  fileChanges: [{ path: "src/settings.ts", action: "create", description: "Expose the settings entry point.", snippet: "export const settings = true;" }],
  plan: "Create src/settings.ts using the existing convention; no new dependency is needed.",
  acceptanceCriteria: "Read src/settings.ts and check that the settings export exists."
};

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

  it("persists a resumable session before the first provider turn finishes", async () => {
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-")) + "/.crewcoder";
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-durable-start-"));
    let sessionId = "";
    let providerStarted: (() => void) | undefined;
    let finishProvider: (() => void) | undefined;
    const providerStart = new Promise<void>((resolve) => { providerStarted = resolve; });
    const providerGate = new Promise<void>((resolve) => { finishProvider = resolve; });

    try {
      const run = runAgentLoop(
        { prompt: "add a settings page", requestedMode: "crewcoder", cwd },
        {
          maxIterations: 1,
          modelClient: {
            async complete(input) {
              sessionId = input.session?.sessionId ?? "";
              providerStarted?.();
              await providerGate;
              return assistantText("done");
            }
          }
        }
      );

      await providerStart;
      const savedWhileProviderWasRunning = await loadSession(sessionId);
      expect(savedWhileProviderWasRunning).toMatchObject({
        id: sessionId,
        requestedMode: "crewcoder",
        resolvedMode: "crewcoder"
      });
      expect(getText(savedWhileProviderWasRunning.messages.at(-1)!)).toBe("add a settings page");

      finishProvider?.();
      await run;
    } finally {
      finishProvider?.();
      if (originalHome === undefined) delete process.env.CREWCODER_HOME; else process.env.CREWCODER_HOME = originalHome;
    }
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
    clarified.inspectionCompleted = true;
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
        modelClient: scriptedClient([toolCall("crewcoder_propose_plan", settingsPlan)])
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

  it("rejects a detailed plan after clarification when no inspection has happened", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-uninspected-plan-"));
    const result = await runAgentLoop({ prompt: "A page", requestedMode: "crewcoder", cwd }, {
      maxIterations: 1, persistSession: false,
      initialCrewcoderWorkflow: recordClarification(emptyCrewcoderWorkflow(), ["Page or modal?"]),
      modelClient: scriptedClient([toolCall("crewcoder_propose_plan", settingsPlan)])
    });
    const response = result.messages.find((message) => message.role === "toolResult")!;
    expect(response).toMatchObject({ isError: true });
    expect(getText(response)).toContain("Clarification alone is not investigation");
  });

  it("investigates after answers, presents file snippets, persists the gate, and waits for approval", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-investigated-plan-"));
    fs.writeFileSync(path.join(cwd, "README.md"), "Use TypeScript exports.\n");
    const result = await runAgentLoop({ prompt: "A page", requestedMode: "crewcoder", cwd }, {
      maxIterations: 3,
      initialCrewcoderWorkflow: recordClarification(emptyCrewcoderWorkflow(), ["Page or modal?"]),
      modelClient: scriptedClient([
        toolCall("read", { path: "README.md" }),
        toolCall("crewcoder_propose_plan", settingsPlan),
        toolCall("write", { path: "src/settings.ts", content: "export {};" })
      ])
    });
    const plan = result.messages.find((message) => message.role === "toolResult" && message.toolName === "crewcoder_propose_plan")!;
    expect(plan).toMatchObject({ isError: false, terminate: true });
    expect(getText(plan)).toContain("Investigation findings:");
    expect(getText(plan)).toContain("create: src/settings.ts");
    expect(getText(plan)).toContain("export const settings = true;");
    expect(fs.existsSync(path.join(cwd, "src/settings.ts"))).toBe(false);
    const saved = await loadSession(result.sessionId);
    expect(saved.crewcoderWorkflow).toMatchObject({ phase: "awaiting_approval", inspectionCompleted: true });
    expect(saved.crewcoderWorkflow?.plan).toContain("export const settings = true;");
    expect(reconstructCrewcoderWorkflow(result.messages).inspectionCompleted).toBe(true);
  });

  it("does not count a failed read as investigation", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-failed-inspection-"));
    const result = await runAgentLoop({ prompt: "A page", requestedMode: "crewcoder", cwd }, {
      maxIterations: 2, persistSession: false,
      initialCrewcoderWorkflow: recordClarification(emptyCrewcoderWorkflow(), ["Page or modal?"]),
      modelClient: scriptedClient([toolCall("read", { path: "missing.ts" }), toolCall("crewcoder_propose_plan", settingsPlan)])
    });
    const results = result.messages.filter((message) => message.role === "toolResult");
    expect(results.every((message) => message.role === "toolResult" && message.isError)).toBe(true);
    expect(getText(results[1]!)).toContain("Inspect the relevant project");
  });
});

describe("crewcoder workflow helpers", () => {
  it("directs investigation both before clarification and after answers", () => {
    expect(formatCrewcoderWorkflowPrompt(emptyCrewcoderWorkflow())).toContain("Search and read the relevant project first");
    const answered = applyIncomingUserMessage(recordClarification(emptyCrewcoderWorkflow(), ["Where?"]), "src/");
    expect(formatCrewcoderWorkflowPrompt(answered)).toContain("Continue read-only investigation");
    const prompt = buildSystemPrompt({ mode: "crewcoder", skills: [], docs: [] });
    expect(prompt).toContain("representative proposed code or diff snippets");
    expect(prompt).toContain("Do that investigation before asking for approval");
  });

  it.each([
    { ...settingsPlan, investigation: " " },
    { ...settingsPlan, fileChanges: undefined },
    { ...settingsPlan, fileChanges: ["src/settings.ts"] },
    { ...settingsPlan, fileChanges: [{ ...settingsPlan.fileChanges[0], action: "guess" }] },
    { ...settingsPlan, fileChanges: [{ ...settingsPlan.fileChanges[0], snippet: "" }] },
    { ...settingsPlan, requirements: {} }
  ])("rejects malformed or incomplete plan input %#", (args) => {
    expect(() => crewcoderProposePlanTool.parse(args)).toThrow();
  });

  it("accepts an inspected analysis deliverable with no file changes", () => {
    expect(crewcoderProposePlanTool.parse({ ...settingsPlan, fileChanges: [], plan: "Explain current settings behavior; no file changes are needed." }).fileChanges).toEqual([]);
  });

  it("counts successful native discovery but ignores failed commands and unrelated tools", () => {
    const state = emptyCrewcoderWorkflow();
    const result: ToolResultMessage = { role: "toolResult", toolCallId: "native", toolName: "Codex command", content: [{ type: "text", text: "source" }], isError: false, timestamp: 1 };
    recordCrewcoderInspection(state, { ...result, details: { exitCode: 1 } }, { command: "cat missing.ts" });
    recordCrewcoderInspection(state, result, { command: "pwd" });
    recordCrewcoderInspection(state, { ...result, toolName: "write" }, {});
    expect(state.inspectionCompleted).toBe(false);
    recordCrewcoderInspection(state, result, { command: "cat src/settings.ts" });
    expect(state.inspectionCompleted).toBe(true);
    expect(result.details?.crewcoderInspection).toBe(true);
    const claude = emptyCrewcoderWorkflow();
    recordCrewcoderInspection(claude, { ...result, toolName: "Read" }, {});
    expect(claude.inspectionCompleted).toBe(true);
  });
  it("classifies plan approval tightly", () => {
    expect(isPlanApprovalMessage("/approve-plan")).toBe(true);
    expect(isPlanApprovalMessage("approve")).toBe(true);
    expect(isPlanApprovalMessage("lgtm")).toBe(true);
    expect(isPlanApprovalMessage("yes, but also add logging")).toBe(false);
    expect(isPlanApprovalMessage("put it in src/settings.ts")).toBe(false);
  });

  it("requires fresh investigation when the user revises a proposed plan", () => {
    const inspected = { ...emptyCrewcoderWorkflow(), inspectionCompleted: true };
    const answered = applyIncomingUserMessage(recordClarification(inspected, ["Where?"]), "src/");
    const planned = recordProposedPlan(answered, settingsPlan);
    const revised = applyIncomingUserMessage(planned, "Use a modal instead of a page.");
    expect(revised).toMatchObject({ phase: "awaiting_plan", inspectionCompleted: false });
    expect(() => recordProposedPlan(revised, settingsPlan)).toThrow("Inspect the relevant project");
    expect(crewcoderMutationBlockReason(writeTool, {}, revised)).toContain("blocked");
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
