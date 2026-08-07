import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveSession, type SessionRecord } from "../core/session-store.js";
import { formatSessionSinceContext, summarizeSessionsSince } from "../core/session-since.js";

let home: string;
const cwd = "/tmp/project-under-test";
const prevHome = process.env.CREWCODER_HOME;

function record(id: string, startedAt: string, over: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    startedAt,
    cwd,
    requestedMode: "auto",
    resolvedMode: "general",
    prompt: `prompt for ${id}`,
    events: [],
    messages: [],
    mutationLog: [],
    ...over
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-since-"));
  process.env.CREWCODER_HOME = home;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = prevHome;
});

describe("session since", () => {
  it("aggregates changed files, tools, and decisions since a timestamp", async () => {
    await saveSession(record("session_a", "2026-01-01T00:00:00.000Z", {
      mutationLog: ["src/a.ts"],
      events: [{ type: "tool_execution_start", toolCallId: "1", toolName: "edit", args: {} }],
      messages: [{ role: "assistant", content: [{ type: "text", text: "Old work" }], stopReason: "end", timestamp: 1 }]
    }));
    await saveSession(record("session_b", "2026-06-01T00:00:00.000Z", {
      mutationLog: ["src/b.ts", "src/b.ts"],
      events: [
        { type: "tool_execution_start", toolCallId: "2", toolName: "edit", args: {} },
        { type: "tool_execution_start", toolCallId: "3", toolName: "bash", args: {} }
      ],
      messages: [{ role: "assistant", content: [{ type: "text", text: "Shipped feature B\nmore detail" }], stopReason: "end", timestamp: 2 }]
    }));

    const summary = await summarizeSessionsSince("2026-03-01T00:00:00.000Z", { cwd });
    expect(summary.sessions.map((s) => s.sessionId)).toEqual(["session_b"]);
    expect(summary.changedFiles).toEqual(["src/b.ts"]);
    expect(summary.toolsRun).toEqual([{ name: "edit", count: 1 }, { name: "bash", count: 1 }]);
    expect(summary.decisions[0]).toContain("Shipped feature B");
    expect(formatSessionSinceContext(summary)).toContain("src/b.ts");
  });

  it("resolves a session id ref to that session's start time", async () => {
    await saveSession(record("session_old", "2026-01-01T00:00:00.000Z"));
    await saveSession(record("session_ref", "2026-05-01T00:00:00.000Z", { mutationLog: ["x.ts"] }));
    await saveSession(record("session_new", "2026-06-01T00:00:00.000Z", { mutationLog: ["y.ts"] }));

    const summary = await summarizeSessionsSince("session_ref", { cwd });
    expect(summary.refSessionId).toBe("session_ref");
    expect(summary.sessions.map((s) => s.sessionId)).toEqual(["session_ref", "session_new"]);
    expect(summary.changedFiles).toEqual(["x.ts", "y.ts"]);
  });
});
