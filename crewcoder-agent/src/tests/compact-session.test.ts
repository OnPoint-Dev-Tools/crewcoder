import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compactDurableSession } from "../core/compact-session.js";
import type { AgentEvent } from "../core/events.js";
import { assistantText, getText, textMessage } from "../core/messages.js";
import type { ModelClient } from "../core/model-client.js";
import { createSessionId, loadSessionRecord, saveSession } from "../core/session-store.js";

function seedMessages(count: number) {
  return Array.from({ length: count }, (_, i) => (i % 2 === 0 ? textMessage("user", `user message ${i}`) : assistantText(`assistant reply ${i}`)));
}

describe("compactDurableSession", () => {
  const previousHome = process.env.CREWCODER_HOME;

  afterEach(() => {
    if (previousHome === undefined) delete process.env.CREWCODER_HOME;
    else process.env.CREWCODER_HOME = previousHome;
  });

  function isolateHome(): void {
    process.env.CREWCODER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-compact-home-"));
  }

  it("rewrites the saved session and clears native continuation", async () => {
    isolateHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-compact-cwd-"));
    const sessionId = createSessionId();
    await saveSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      cwd,
      requestedMode: "general",
      resolvedMode: "general",
      prompt: "user message 0",
      events: [],
      messages: seedMessages(20),
      mutationLog: [],
      providerSessionIds: { codex: "thread-1" },
      usage: { turns: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2, lastInputTokens: 9000 }
    });
    const modelClient: ModelClient = {
      async complete() {
        return assistantText("- Goal: keep the rewrite\n- Status: tests passing");
      }
    };
    const events: AgentEvent[] = [];

    const result = await compactDurableSession({
      sessionId,
      modelClient,
      cwd,
      emit: (event) => { events.push(event); }
    });

    expect(result.compacted).toBe(true);
    expect(result.summary).toContain("keep the rewrite");
    expect(result.originalMessageCount).toBe(20);
    const stored = await loadSessionRecord(sessionId);
    expect(stored.messages.length).toBe(result.retainedMessageCount + 1);
    expect(getText(stored.messages[0]!)).toContain("keep the rewrite");
    expect(stored.providerSessionIds).toEqual({});
    expect(stored.usage?.lastInputTokens).toBe(0);
    expect(events.some((event) => event.type === "session_compacted" && event.automatic === false)).toBe(true);
  });

  it("returns a preview without saving", async () => {
    isolateHome();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-compact-preview-"));
    const sessionId = createSessionId();
    await saveSession({
      id: sessionId,
      startedAt: new Date().toISOString(),
      cwd,
      requestedMode: "general",
      resolvedMode: "general",
      prompt: "user message 0",
      events: [],
      messages: seedMessages(20),
      mutationLog: []
    });

    const result = await compactDurableSession({
      sessionId,
      modelClient: { async complete() { return assistantText("preview summary"); } },
      cwd,
      preview: true
    });

    expect(result).toMatchObject({ compacted: false, preview: true, summary: "preview summary" });
    expect((await loadSessionRecord(sessionId)).messages).toHaveLength(20);
  });
});
