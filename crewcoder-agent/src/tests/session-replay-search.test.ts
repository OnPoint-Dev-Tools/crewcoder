import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assistantText } from "../core/messages.js";
import { assignAssistantHashes } from "../core/message-hash.js";
import type { ModelClient, ModelInput } from "../core/model-client.js";
import { replaySessionTurn } from "../core/reproducible-run.js";
import { searchSessions } from "../core/session-search.js";
import { loadSessionRecord, saveSession } from "../core/session-store.js";

let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.CREWCODER_HOME;
  process.env.CREWCODER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-replay-home-"));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = previousHome;
});

const modelInput: ModelInput = {
  systemPrompt: "Exact system prompt",
  messages: [{ role: "user", content: [{ type: "text", text: "trigger TS2322" }], timestamp: 1 }],
  availableTools: [{ name: "read", description: "Read a file" }],
  session: { sessionId: "source", continuation: false }
};

describe("session hashes, search, and replay", () => {
  it("creates stable prompt and response hashes independent of timestamps", () => {
    const first = assignAssistantHashes({ ...assistantText("error TS2322"), timestamp: 1 }, modelInput);
    const second = assignAssistantHashes({ ...assistantText("error TS2322"), timestamp: 999 }, modelInput);
    expect(first.id).toMatch(/^pr_/);
    expect(first).toMatchObject({ id: second.id, promptHash: second.promptHash, responseHash: second.responseHash });
  });

  it("searches message text and exposes response IDs", async () => {
    const response = assignAssistantHashes(assistantText("Compiler error TS2322 in config.ts"), modelInput);
    await saveSession({ id: "source", startedAt: "2026-01-01T00:00:00.000Z", cwd: process.cwd(), requestedMode: "general", resolvedMode: "general", prompt: "compile", events: [], messages: [...modelInput.messages, response], modelTurns: [{ iteration: 1, input: modelInput, promptHash: response.promptHash ?? "", responseHash: response.responseHash ?? "", responseId: response.id ?? "" }], mutationLog: [] });
    const matches = await searchSessions("TS2322");
    expect(matches).toHaveLength(2);
    expect(matches.find((match) => match.role === "assistant")).toMatchObject({ sessionId: "source", messageId: response.id, responseHash: response.responseHash });
    expect(await searchSessions(response.id ?? "missing")).toHaveLength(1);
  });

  it("replays the exact stored model input into a new linked session", async () => {
    const original = assignAssistantHashes(assistantText("deterministic response"), modelInput);
    await saveSession({ id: "source", startedAt: "2026-01-01T00:00:00.000Z", cwd: process.cwd(), requestedMode: "general", resolvedMode: "general", prompt: "compile", provider: "test", model: "model", events: [], messages: [...modelInput.messages, original], modelTurns: [{ iteration: 1, input: modelInput, promptHash: original.promptHash ?? "", responseHash: original.responseHash ?? "", responseId: original.id ?? "" }], mutationLog: [] });
    let captured: ModelInput | undefined;
    const client: ModelClient = { async complete(input) { captured = input; return assistantText("deterministic response"); } };
    const result = await replaySessionTurn({ sessionId: "source", turn: 1, modelClient: client, providerId: "test", model: "model" });
    expect(captured).toEqual(modelInput);
    expect(result).toMatchObject({ sourceSessionId: "source", sourceTurn: 1, promptHash: original.promptHash, originalResponseHash: original.responseHash, replayResponseHash: original.responseHash, matched: true });
    const replay = await loadSessionRecord(result.sessionId);
    expect(replay.parentSessionId).toBe("source");
    expect(replay.modelTurns?.[0]?.input).toEqual(modelInput);
  });
});
