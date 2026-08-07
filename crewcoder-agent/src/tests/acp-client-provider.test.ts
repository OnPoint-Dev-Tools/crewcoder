import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAcpClientProvider } from "../providers/acp-client-provider.js";
import type { ProviderDefinition, ProviderRunInput } from "../providers/types.js";
import type { ModelStreamCallbacks } from "../core/model-client.js";
import type { AssistantMessage } from "../core/messages.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

function provider(mode: string, command = process.execPath): ProviderDefinition {
  return {
    id: "grok",
    title: "Grok CLI",
    kind: "builtin",
    runtime: "acp-client",
    command,
    args: [FIXTURE, "{{modelArg:--model}}", "{{effortArg:--reasoning-effort}}"],
    env: { CREWCODER_FAKE_ACP_MODE: mode }
  };
}

type Recorded = {
  assistant: string[];
  thinking: string[];
  toolStarts: Array<{ name: string; arguments: Record<string, unknown> }>;
  toolEnds: Array<{ toolName: string; text: string; isError: boolean }>;
  sessionIds: string[];
  usage: Array<Record<string, unknown>>;
  questions: Array<{ title: string }>;
};

function recorder(answer?: string): { stream: ModelStreamCallbacks; recorded: Recorded } {
  const recorded: Recorded = { assistant: [], thinking: [], toolStarts: [], toolEnds: [], sessionIds: [], usage: [], questions: [] };
  const stream: ModelStreamCallbacks = {
    onAssistantDelta: (text) => { recorded.assistant.push(text); },
    onThinkingDelta: (text) => { recorded.thinking.push(text); },
    onProviderToolStart: (call) => { recorded.toolStarts.push({ name: call.name, arguments: call.arguments }); },
    onProviderToolEnd: (result) => { recorded.toolEnds.push({ toolName: result.toolName, text: result.text, isError: result.isError }); },
    onProviderSessionId: (id) => { recorded.sessionIds.push(id); },
    onUsage: (usage) => { recorded.usage.push(usage as unknown as Record<string, unknown>); },
    requestQuestion: async (question) => { recorded.questions.push({ title: question.title }); return answer; }
  };
  return { stream, recorded };
}

function request(mode: string, cwd: string, stream?: ModelStreamCallbacks, providerSessionId?: string): ProviderRunInput {
  return {
    provider: provider(mode),
    prompt: "system\n\nUser request:\nhello",
    cwd,
    model: "grok-4.5",
    modelInput: {
      systemPrompt: "system",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 }],
      availableTools: [],
      ...(providerSessionId ? { session: { sessionId: "cc-1", continuation: true, providerSessionId } } : {})
    },
    stream
  };
}

let cwd: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-acp-"));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

describe("acp client provider", () => {
  it("streams assistant text, thinking, and native tool activity from the remote agent", async () => {
    const { stream, recorded } = recorder();
    const result = await runAcpClientProvider(request("ok", cwd, stream));

    expect(result.exitCode).toBe(0);
    const assistant = JSON.parse(result.text) as AssistantMessage;
    expect(assistant.role).toBe("assistant");
    expect(assistant.stopReason).toBe("end");
    expect(assistant.content[0]).toMatchObject({ type: "text" });
    expect(result.stdout).toContain("Hello from Grok.");

    expect(recorded.assistant.slice(0, 2)).toEqual(["Hello ", "from Grok."]);
    expect(recorded.thinking).toEqual(["thinking hard"]);
    expect(recorded.sessionIds).toEqual(["fake-session-1"]);
    expect(recorded.toolStarts).toEqual([{ name: "read package.json", arguments: { path: "package.json" } }]);
    expect(recorded.toolEnds).toEqual([{ toolName: "read package.json", text: "file body", isError: false }]);
  });

  it("passes model and reasoning effort as spawn flags", async () => {
    const result = await runAcpClientProvider({ ...request("ok", cwd), reasoningEffort: "high" });
    expect(result.stdout).toContain("--model,grok-4.5");
    expect(result.stdout).toContain("--reasoning-effort,high");
  });

  it("omits the model and effort flags when neither is selected", async () => {
    const input = request("ok", cwd);
    const result = await runAcpClientProvider({ ...input, model: "default", reasoningEffort: "none" });
    expect(result.stdout).not.toContain("--model");
    expect(result.stdout).not.toContain("--reasoning-effort");
  });

  it("reports live context tokens but never the cumulative ACP cost", async () => {
    const result = await runAcpClientProvider(request("ok", cwd));
    expect(result.usage).toEqual({ providerId: "grok", model: "grok-4.5", contextTokens: 4321 });
    // ACP `cost` is a running session total; feeding it to the per-turn ledger would overstate spend.
    expect(result.usage).not.toHaveProperty("costUsd");
  });

  it("routes permission requests to the interactive question channel", async () => {
    const { stream, recorded } = recorder("allow-once");
    const result = await runAcpClientProvider(request("permission", cwd, stream));

    expect(recorded.questions[0]?.title).toContain("rm -rf /");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("outcome:allow-once");
  });

  it("rejects tool permission when no interactive host is attached", async () => {
    const result = await runAcpClientProvider(request("permission", cwd));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("outcome:reject-once");
  });

  it("serves fs reads inside the workspace and denies path escapes", async () => {
    await fs.writeFile(path.join(cwd, "acp-fixture.txt"), "workspace content", "utf8");
    const result = await runAcpClientProvider(request("fs", cwd));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("read:workspace content|escape:denied");
    await expect(fs.access(path.join(cwd, "..", "..", "escaped.txt"))).rejects.toThrow();
  });

  it("falls back to a new session when the agent cannot load the stored session id", async () => {
    const { stream, recorded } = recorder();
    const result = await runAcpClientProvider(request("load-fails", cwd, stream, "stale-session"));

    expect(result.exitCode).toBe(0);
    expect(recorded.sessionIds).toEqual(["fake-session-1"]);
  });

  it("reuses the stored agent session id when the agent loads it", async () => {
    const { stream, recorded } = recorder();
    const result = await runAcpClientProvider(request("ok", cwd, stream, "kept-session"));

    expect(result.exitCode).toBe(0);
    expect(recorded.sessionIds).toEqual(["kept-session"]);
  });

  it("treats an empty turn as a provider failure rather than a successful reply", async () => {
    const result = await runAcpClientProvider(request("empty", cwd));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("returned no assistant output");
  });

  it("treats a refusal as a provider failure", async () => {
    const result = await runAcpClientProvider(request("refusal", cwd));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("refusal");
  });

  it("reports a missing agent binary as an actionable provider error", async () => {
    const input = request("ok", cwd);
    const result = await runAcpClientProvider({ ...input, provider: { ...provider("ok", "definitely-not-a-real-binary-xyz") } });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not found on PATH");
  });
});
