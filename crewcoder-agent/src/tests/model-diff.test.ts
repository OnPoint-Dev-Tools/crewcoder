import { describe, expect, it } from "vitest";
import { candidateLabel, diffModels, formatDiffRow, parseModelSpecs, type ModelCandidate } from "../core/model-diff.js";
import { assistantText, type AssistantMessage } from "../core/messages.js";
import type { ModelClient, ModelInput, ModelStreamCallbacks } from "../core/model-client.js";
import type { ModelUsage } from "../core/usage.js";

const KNOWN = { knownProviderIds: ["codex", "opencode", "claude"], defaultProviderId: "codex" };

class StubModelClient implements ModelClient {
  inputs: ModelInput[] = [];
  constructor(
    private readonly reply: AssistantMessage | Error,
    private readonly usage?: ModelUsage,
    private readonly delayMs = 0
  ) {}
  async complete(input: ModelInput, _signal?: AbortSignal, stream?: ModelStreamCallbacks): Promise<AssistantMessage> {
    this.inputs.push(input);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    if (this.usage) await stream?.onUsage?.(this.usage);
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

describe("parseModelSpecs", () => {
  it("splits comma lists and repeated flags into deduped candidates", () => {
    expect(parseModelSpecs(["codex:gpt-5.6,opencode:sonnet", "codex:gpt-5.6"], KNOWN)).toEqual([
      { providerId: "codex", model: "gpt-5.6", label: "codex:gpt-5.6" },
      { providerId: "opencode", model: "sonnet", label: "opencode:sonnet" }
    ]);
  });

  it("treats a bare model id as the default provider's model", () => {
    expect(parseModelSpecs(["gpt-5.6"], KNOWN)).toEqual([{ providerId: "codex", model: "gpt-5.6", label: "codex:gpt-5.6" }]);
  });

  it("treats a bare known provider id as that provider's default model", () => {
    expect(parseModelSpecs(["opencode"], KNOWN)).toEqual([{ providerId: "opencode", label: "opencode:default" }]);
  });

  it("keeps a colon that belongs to the model id when the prefix is not a known provider", () => {
    // `qwen` is not a provider, so this must stay one model on the default provider
    // rather than being routed to a provider that does not exist.
    expect(parseModelSpecs(["qwen-2.5:free"], KNOWN)).toEqual([
      { providerId: "codex", model: "qwen-2.5:free", label: "codex:qwen-2.5:free" }
    ]);
  });

  it("ignores blank specs", () => {
    expect(parseModelSpecs([" , ", ""], KNOWN)).toEqual([]);
  });
});

describe("diffModels", () => {
  const candidates: ModelCandidate[] = [
    { providerId: "codex", model: "a", label: candidateLabel("codex", "a") },
    { providerId: "opencode", model: "b", label: candidateLabel("opencode", "b") }
  ];

  it("runs the same prompt against every candidate with no tools and no session", async () => {
    const clients = new Map<string, StubModelClient>([
      ["codex:a", new StubModelClient(assistantText("answer from a"))],
      ["opencode:b", new StubModelClient(assistantText("answer from b"))]
    ]);
    const report = await diffModels({
      prompt: "explain generics",
      candidates,
      createModelClient: (candidate) => clients.get(candidate.label)!
    });

    expect(report.results.map((result) => result.text)).toEqual(["answer from a", "answer from b"]);
    expect(report.results.every((result) => result.ok)).toBe(true);
    for (const client of clients.values()) {
      expect(client.inputs[0]?.availableTools).toEqual([]);
      expect(client.inputs[0]?.session).toBeUndefined();
    }
  });

  it("records a provider error result instead of failing the whole comparison", async () => {
    const report = await diffModels({
      prompt: "hi",
      candidates,
      createModelClient: (candidate) => candidate.label === "codex:a"
        ? new StubModelClient({ ...assistantText("codex request failed", "error"), errorMessage: "401 unauthorized" })
        : new StubModelClient(assistantText("still fine"))
    });

    expect(report.results[0]?.ok).toBe(false);
    expect(report.results[0]?.errorMessage).toBe("401 unauthorized");
    expect(report.results[1]).toMatchObject({ ok: true, text: "still fine" });
  });

  it("records a thrown client error as a failed candidate", async () => {
    const report = await diffModels({
      prompt: "hi",
      candidates: [candidates[0]!],
      createModelClient: () => new StubModelClient(new Error("socket hang up"))
    });
    expect(report.results[0]).toMatchObject({ ok: false, errorMessage: "socket hang up", text: "" });
  });

  it("captures reported usage and leaves cost absent for an unpriced model", async () => {
    const report = await diffModels({
      prompt: "hi",
      candidates: [{ providerId: "codex", model: "definitely-not-a-real-model-xyz", label: "codex:definitely-not-a-real-model-xyz" }],
      createModelClient: () => new StubModelClient(assistantText("ok"), {
        providerId: "codex",
        model: "definitely-not-a-real-model-xyz",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120
      })
    });

    expect(report.results[0]?.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, totalTokens: 120 });
    // Unpriced is not free: costUsd must be absent, never 0.
    expect(report.results[0]?.costUsd).toBeUndefined();
  });

  it("reports per-candidate latency and a total shorter than the sum when parallel", async () => {
    const report = await diffModels({
      prompt: "hi",
      candidates,
      concurrent: true,
      createModelClient: () => new StubModelClient(assistantText("ok"), undefined, 60)
    });
    expect(report.results.every((result) => result.latencyMs >= 50)).toBe(true);
    expect(report.totalMs).toBeLessThan(report.results.reduce((sum, result) => sum + result.latencyMs, 0));
    expect(report.concurrent).toBe(true);
  });

  it("runs sequentially when asked", async () => {
    const order: string[] = [];
    const report = await diffModels({
      prompt: "hi",
      candidates,
      concurrent: false,
      createModelClient: (candidate) => {
        order.push(candidate.label);
        return new StubModelClient(assistantText("ok"));
      }
    });
    expect(order).toEqual(["codex:a", "opencode:b"]);
    expect(report.concurrent).toBe(false);
  });
});

describe("formatDiffRow", () => {
  it("summarizes a result in one line", () => {
    expect(formatDiffRow({
      candidate: { providerId: "codex", model: "a", label: "codex:a" },
      ok: true,
      text: "hello",
      latencyMs: 1200,
      usage: { totalTokens: 340 }
    })).toBe("codex:a ok 1200ms 340 tokens");
  });
});
