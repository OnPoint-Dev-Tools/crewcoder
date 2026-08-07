import { describe, expect, it } from "vitest";
import { describeDecision, explainLastDecision, extractLastDecision, formatDecisionEvidence } from "../core/session-why.js";
import { assistantText, textMessage, type AgentMessage, type AssistantMessage } from "../core/messages.js";
import type { ModelClient, ModelInput } from "../core/model-client.js";
import type { SessionRecord } from "../core/session-store.js";

function record(messages: AgentMessage[], mutationLog: string[] = []): SessionRecord {
  return {
    id: "sess_test",
    startedAt: new Date().toISOString(),
    cwd: "/repo",
    requestedMode: "auto",
    resolvedMode: "general",
    prompt: "initial",
    events: [],
    messages,
    mutationLog
  };
}

function toolCallMessage(id: string, name: string, args: Record<string, unknown>, text = ""): AssistantMessage {
  return {
    role: "assistant",
    content: [...(text ? [{ type: "text" as const, text }] : []), { type: "toolCall", id, name, arguments: args }],
    stopReason: "tool_calls",
    timestamp: Date.now()
  };
}

class StubModelClient implements ModelClient {
  inputs: ModelInput[] = [];
  constructor(private readonly reply: AssistantMessage | Error) {}
  async complete(input: ModelInput): Promise<AssistantMessage> {
    this.inputs.push(input);
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

describe("extractLastDecision", () => {
  it("returns the last assistant turn with its request, tool calls, and results", () => {
    const decision = extractLastDecision(record([
      textMessage("user", "add a retry to the fetch helper"),
      toolCallMessage("call_1", "read", { path: "src/fetch.ts" }, "Reading the helper first."),
      { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "export async function fetchJson() {}" }], isError: false, timestamp: Date.now() }
    ], ["src/fetch.ts"]));

    expect(decision).toBeDefined();
    expect(decision?.request).toBe("add a retry to the fetch helper");
    expect(decision?.assistantText).toBe("Reading the helper first.");
    expect(decision?.stopReason).toBe("tool_calls");
    expect(decision?.changedFiles).toEqual(["src/fetch.ts"]);
    expect(decision?.toolCalls).toEqual([
      { name: "read", arguments: { path: "src/fetch.ts" }, ok: true, result: "export async function fetchJson() {}" }
    ]);
  });

  it("marks a failed tool result and leaves ok undefined when no result was recorded", () => {
    const decision = extractLastDecision(record([
      textMessage("user", "run the tests"),
      toolCallMessage("call_1", "bash", { command: "npm test" }),
      { role: "toolResult", toolCallId: "call_1", toolName: "bash", content: [{ type: "text", text: "1 failing" }], isError: true, timestamp: Date.now() },
      toolCallMessage("call_2", "bash", { command: "npm run lint" })
    ]));

    expect(decision?.toolCalls).toEqual([{ name: "bash", arguments: { command: "npm run lint" } }]);
  });

  it("skips empty assistant turns and keeps a provider error turn", () => {
    const decision = extractLastDecision(record([
      textMessage("user", "explain the loop"),
      assistantText("The loop runs until the model stops."),
      { role: "assistant", content: [], stopReason: "error", errorMessage: "402 billing", timestamp: Date.now() }
    ]));

    expect(decision?.stopReason).toBe("error");
    expect(decision?.errorMessage).toBe("402 billing");
  });

  it("returns undefined for a session with no assistant content", () => {
    expect(extractLastDecision(record([textMessage("user", "hi")]))).toBeUndefined();
  });
});

describe("formatDecisionEvidence", () => {
  it("includes the request, reply, tool calls, results, and changed files", () => {
    const decision = extractLastDecision(record([
      textMessage("user", "add a retry"),
      toolCallMessage("call_1", "edit", { path: "src/fetch.ts", replace: "retry" }, "Adding a bounded retry."),
      { role: "toolResult", toolCallId: "call_1", toolName: "edit", content: [{ type: "text", text: "applied" }], isError: false, timestamp: Date.now() }
    ], ["src/fetch.ts"]))!;

    const evidence = formatDecisionEvidence(decision);
    expect(evidence).toContain("add a retry");
    expect(evidence).toContain("Adding a bounded retry.");
    expect(evidence).toContain("edit(path: src/fetch.ts, replace: retry) — succeeded");
    expect(evidence).toContain("result: applied");
    expect(evidence).toContain("Files changed in this session so far: src/fetch.ts");
  });

  it("says plainly when no tools ran", () => {
    const decision = extractLastDecision(record([textMessage("user", "why?"), assistantText("Because the cache was stale.")]))!;
    expect(formatDecisionEvidence(decision)).toContain("It ran no tools on this turn.");
  });
});

describe("explainLastDecision", () => {
  it("asks the model with no tools available and returns the explanation", async () => {
    const client = new StubModelClient(assistantText("- It read the helper first\n- Because the request named it"));
    const why = await explainLastDecision(record([
      textMessage("user", "add a retry"),
      toolCallMessage("call_1", "read", { path: "src/fetch.ts" }, "Reading first.")
    ]), { modelClient: client });

    expect(why?.source).toBe("model");
    expect(why?.explanation).toContain("It read the helper first");
    expect(why?.fallbackReason).toBeUndefined();
    expect(client.inputs[0]?.availableTools).toEqual([]);
    expect(client.inputs[0]?.systemPrompt).toContain("explaining a coding agent's most recent decision");
  });

  it("falls back to a transcript readout and reports why when the model throws", async () => {
    const client = new StubModelClient(new Error("network down"));
    const why = await explainLastDecision(record([
      textMessage("user", "run the tests"),
      toolCallMessage("call_1", "bash", { command: "npm test" }, "Running the suite.")
    ]), { modelClient: client });

    expect(why?.source).toBe("transcript");
    expect(why?.fallbackReason).toBe("network down");
    expect(why?.explanation).toContain("It ran bash(command: npm test)");
  });

  it("treats a provider error response as a fallback, not an explanation", async () => {
    const errored: AssistantMessage = { role: "assistant", content: [], stopReason: "error", errorMessage: "401 unauthorized", timestamp: Date.now() };
    const why = await explainLastDecision(record([
      textMessage("user", "why"),
      assistantText("Because the config changed.")
    ]), { modelClient: new StubModelClient(errored) });

    expect(why?.source).toBe("transcript");
    expect(why?.fallbackReason).toBe("401 unauthorized");
  });

  it("treats an empty model reply as a fallback", async () => {
    const why = await explainLastDecision(record([
      textMessage("user", "why"),
      assistantText("Because the config changed.")
    ]), { modelClient: new StubModelClient(assistantText("   ")) });

    expect(why?.source).toBe("transcript");
    expect(why?.fallbackReason).toBe("The provider returned an empty explanation.");
  });

  it("returns undefined when there is no decision to explain", async () => {
    const why = await explainLastDecision(record([textMessage("user", "hello")]), { modelClient: new StubModelClient(assistantText("unused")) });
    expect(why).toBeUndefined();
  });
});

describe("describeDecision", () => {
  it("reports the provider error when the last turn failed", () => {
    const decision = extractLastDecision(record([
      textMessage("user", "go"),
      { role: "assistant", content: [], stopReason: "error", errorMessage: "402 billing", timestamp: Date.now() }
    ]))!;

    expect(describeDecision(decision)).toContain("The turn failed with a provider error: 402 billing");
  });
});
