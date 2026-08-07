import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { textMessage, assistantText } from "../core/messages.js";
import { listSessionSummaries } from "../core/session-admin.js";
import { listSessionHeaders, saveSession, sessionFilePath, type SessionRecord } from "../core/session-store.js";

const originalHome = process.env.CREWCODER_HOME;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-listing-"));
  process.env.CREWCODER_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function record(id: string, cwd: string, startedAt: string, messageCount: number): SessionRecord {
  const messages = Array.from({ length: messageCount }, (_, i) =>
    i % 2 === 0 ? textMessage("user", `prompt ${i}`) : assistantText(`reply ${i}`));
  return {
    id,
    startedAt,
    cwd,
    requestedMode: "general",
    resolvedMode: "general",
    prompt: `prompt for ${id}`,
    provider: "codex",
    model: "gpt-5.6-luna",
    events: [],
    messages,
    mutationLog: []
  };
}

describe("session listing", () => {
  it("returns header fields without reading message bodies", async () => {
    await saveSession(record("session_a", "/tmp/one", "2026-01-01T00:00:00.000Z", 4));

    const [summary] = await listSessionSummaries();

    expect(summary).toMatchObject({
      id: "session_a",
      cwd: "/tmp/one",
      startedAt: "2026-01-01T00:00:00.000Z",
      prompt: "prompt for session_a",
      provider: "codex",
      model: "gpt-5.6-luna",
      resolvedMode: "general"
    });
    // Absent, not a confident zero: the count genuinely was not loaded.
    expect(summary).not.toHaveProperty("messageCount", 0);
    expect(summary?.messageCount).toBeUndefined();
  });

  it("includes messageCount only when explicitly requested", async () => {
    await saveSession(record("session_a", "/tmp/one", "2026-01-01T00:00:00.000Z", 4));

    const [summary] = await listSessionSummaries({ includeMessageCount: true });

    expect(summary?.messageCount).toBe(4);
  });

  it("filters by cwd and sorts newest first on the header path", async () => {
    await saveSession(record("session_old", "/tmp/one", "2026-01-01T00:00:00.000Z", 2));
    await saveSession(record("session_new", "/tmp/one", "2026-06-01T00:00:00.000Z", 2));
    await saveSession(record("session_other", "/tmp/two", "2026-09-01T00:00:00.000Z", 2));

    const all = await listSessionSummaries();
    expect(all.map((s) => s.id)).toEqual(["session_other", "session_new", "session_old"]);

    const scoped = await listSessionSummaries({ cwd: "/tmp/one" });
    expect(scoped.map((s) => s.id)).toEqual(["session_new", "session_old"]);
  });

  it("lists the same sessions as the full-parse path", async () => {
    await saveSession(record("session_a", "/tmp/one", "2026-01-01T00:00:00.000Z", 6));
    await saveSession(record("session_b", "/tmp/two", "2026-02-01T00:00:00.000Z", 2));

    const headers = await listSessionSummaries();
    const full = await listSessionSummaries({ includeMessageCount: true });

    expect(headers.map((s) => s.id)).toEqual(full.map((s) => s.id));
  });

  it("stops reading after the header line", async () => {
    await saveSession(record("session_a", "/tmp/one", "2026-01-01T00:00:00.000Z", 2));
    // Corrupt everything after the header. A full parse would throw; the header
    // path must not care, because it never reads these lines.
    const file = sessionFilePath("session_a");
    const [header] = fs.readFileSync(file, "utf8").split("\n");
    fs.writeFileSync(file, `${header}\n{ this is not json at all\n`, "utf8");

    const [summary] = await listSessionHeaders();

    expect(summary?.id).toBe("session_a");
    expect(summary?.prompt).toBe("prompt for session_a");
  });

  it("skips directories that are not sessions instead of failing the listing", async () => {
    await saveSession(record("session_a", "/tmp/one", "2026-01-01T00:00:00.000Z", 2));
    fs.mkdirSync(path.join(home, "sessions", "not-a-session"), { recursive: true });

    const summaries = await listSessionSummaries();

    expect(summaries.map((s) => s.id)).toEqual(["session_a"]);
  });
});
