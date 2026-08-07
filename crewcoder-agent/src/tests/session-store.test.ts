import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assistantText, textMessage, type AgentMessage } from "../core/messages.js";
import type { AgentEvent } from "../core/events.js";
import { emptyUsageSummary } from "../core/usage.js";
import { listSessionHeaders, listSessions, loadSessionRecord, saveSession, sessionFilePath, whenSessionWritesSettle, type SessionRecord } from "../core/session-store.js";

const originalHome = process.env.CREWCODER_HOME;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-sessions-"));
  process.env.CREWCODER_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function baseRecord(id: string): SessionRecord {
  return {
    id,
    startedAt: new Date().toISOString(),
    cwd: "/tmp/project",
    requestedMode: "auto",
    resolvedMode: "general",
    prompt: "hello",
    provider: "codex",
    model: "gpt-test",
    events: [],
    messages: [],
    mutationLog: [],
    usage: emptyUsageSummary()
  };
}

function metadataLines(id: string): Array<{ delta?: boolean; events?: unknown[] }> {
  return fs.readFileSync(sessionFilePath(id), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.type === "metadata");
}

describe("session-store durable growth", () => {
  it("appends events as deltas instead of re-embedding the cumulative log", async () => {
    const id = "session_delta";
    const messages: AgentMessage[] = [];
    const events: AgentEvent[] = [];
    for (let turn = 0; turn < 5; turn++) {
      messages.push(textMessage("user", `turn ${turn}`));
      messages.push(assistantText(`reply ${turn}`));
      events.push({ type: "tool_execution_start", toolCallId: `t${turn}`, toolName: "read", args: {} });
      // Streaming deltas must never be persisted.
      events.push({ type: "assistant_delta", text: "x".repeat(50) });
      await saveSession({ ...baseRecord(id), messages: [...messages], events: [...events] });
    }

    const metas = metadataLines(id);
    // Every metadata entry is a small delta, not a growing cumulative snapshot.
    expect(metas.every((meta) => meta.delta === true)).toBe(true);
    expect(metas.every((meta) => (meta.events?.length ?? 0) <= 1)).toBe(true);

    const record = await loadSessionRecord(id);
    expect(record.messages).toHaveLength(10);
    // Live deltas filtered out; only the 5 durable tool events remain.
    expect(record.events).toHaveLength(5);
    expect(record.events.every((event) => event.type === "tool_execution_start")).toBe(true);
  });

  it("persists external directory changes in append-only metadata", async () => {
    const id = "session_external_dirs";
    await saveSession({ ...baseRecord(id), externalDirectories: ["/tmp/shared-one"] });
    await saveSession({ ...baseRecord(id), externalDirectories: ["/tmp/shared-two"] });
    expect((await loadSessionRecord(id)).externalDirectories).toEqual(["/tmp/shared-two"]);
  });

  it("persists provider-native session ids in append-only metadata", async () => {
    const id = "session_provider_ids";
    await saveSession({ ...baseRecord(id), providerSessionIds: { claude: "claude-native-1" } });
    await saveSession({ ...baseRecord(id), providerSessionIds: { claude: "claude-native-2", codex: "codex-native" } });
    expect((await loadSessionRecord(id)).providerSessionIds).toEqual({ claude: "claude-native-2", codex: "codex-native" });
  });

  it("atomically replaces non-append-only history after compaction", async () => {
    const id = "session_compacted_history";
    const original = [textMessage("user", "old request"), assistantText("old response"), textMessage("user", "latest request")];
    await saveSession({ ...baseRecord(id), messages: original });
    const compacted = [textMessage("user", "Background from compacted earlier session: summary"), textMessage("user", "latest request")];
    await saveSession({ ...baseRecord(id), messages: compacted, providerSessionIds: {} });
    const loaded = await loadSessionRecord(id);
    expect(loaded.messages).toEqual(compacted);
    expect(loaded.providerSessionIds).toEqual({});
  });

  it("keeps the file from growing quadratically across many saves", async () => {
    const id = "session_linear";
    const messages: AgentMessage[] = [];
    for (let turn = 0; turn < 40; turn++) {
      messages.push(assistantText(`reply ${turn}`));
      await saveSession({ ...baseRecord(id), messages: [...messages] });
    }
    // 40 cumulative snapshots would be ~O(n^2); a delta log stays tiny.
    expect(fs.statSync(sessionFilePath(id)).size).toBeLessThan(200_000);
    expect((await loadSessionRecord(id)).messages).toHaveLength(40);
  });

  it("still reads a legacy cumulative-snapshot session and appends without duplication", async () => {
    const id = "session_legacy";
    const dir = path.dirname(sessionFilePath(id));
    fs.mkdirSync(dir, { recursive: true });
    // Legacy format: a single metadata snapshot with no `delta` flag.
    const legacy = [
      { type: "session", version: 2, id, timestamp: new Date().toISOString(), cwd: "/tmp/project", requestedMode: "auto", resolvedMode: "general", prompt: "hi" },
      { type: "message", id: "e1", parentId: null, timestamp: new Date().toISOString(), message: textMessage("user", "old") },
      { type: "metadata", id: "m1", parentId: "e1", timestamp: new Date().toISOString(), events: [{ type: "tool_execution_start", toolCallId: "old", toolName: "read", args: {} }], mutationLog: ["old-edit"] }
    ];
    fs.writeFileSync(sessionFilePath(id), legacy.map((entry) => JSON.stringify(entry)).join("\n") + "\n");

    const loaded = await loadSessionRecord(id);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.events).toHaveLength(1);
    expect(loaded.mutationLog).toEqual(["old-edit"]);

    await saveSession({ ...baseRecord(id), messages: [loaded.messages[0]!, assistantText("new")], events: loaded.events, mutationLog: [...loaded.mutationLog, "new-edit"] });
    const after = await loadSessionRecord(id);
    expect(after.messages).toHaveLength(2);
    expect(after.events).toHaveLength(1); // not duplicated across the legacy->delta boundary
    expect(after.mutationLog).toEqual(["old-edit", "new-edit"]);
  });

  it("surfaces an unreadable session as a header stub instead of dropping it", async () => {
    const id = "session_corrupt";
    const dir = path.dirname(sessionFilePath(id));
    fs.mkdirSync(dir, { recursive: true });
    const header = { type: "session", version: 2, id, timestamp: new Date().toISOString(), cwd: "/tmp/project", requestedMode: "auto", resolvedMode: "general", prompt: "corrupt one" };
    fs.writeFileSync(sessionFilePath(id), JSON.stringify(header) + "\n" + "{ this is not valid json\n");

    await expect(loadSessionRecord(id)).rejects.toBeTruthy();
    const listed = await listSessions("/tmp/project");
    const stub = listed.find((session) => session.id === id);
    expect(stub).toBeTruthy();
    expect(stub!.loadError).toBeTruthy();
    expect(stub!.prompt).toBe("corrupt one");
  });

  it("resumes on the provider/model/effort of the most recent run, not the first", async () => {
    const id = "session_runtime_switch";
    // Same message objects across both saves so this exercises the append path,
    // not the atomic rewrite (which legitimately refreshes the header).
    const first = textMessage("user", "one");
    const second = textMessage("user", "two");
    await saveSession({ ...baseRecord(id), messages: [first] });
    await saveSession({
      ...baseRecord(id),
      provider: "opencode",
      model: "claude-sonnet-4-6",
      effort: "high",
      messages: [first, second]
    });

    // The append-only header still records where the session started...
    const header = JSON.parse(fs.readFileSync(sessionFilePath(id), "utf8").split("\n")[0]!);
    expect(header.provider).toBe("codex");
    expect(header.model).toBe("gpt-test");

    // ...but both the full load and the header-only listing report the last run.
    const loaded = await loadSessionRecord(id);
    expect(loaded).toMatchObject({ provider: "opencode", model: "claude-sonnet-4-6", effort: "high" });
    const listed = (await listSessionHeaders("/tmp/project")).find((session) => session.id === id);
    expect(listed).toMatchObject({ provider: "opencode", model: "claude-sonnet-4-6", effort: "high" });
  });

  it("falls back to the header when the runtime sidecar is missing or corrupt", async () => {
    const id = "session_runtime_corrupt";
    await saveSession({ ...baseRecord(id), effort: "medium" });
    const runtimeFile = path.join(path.dirname(sessionFilePath(id)), "runtime.json");
    expect(JSON.parse(fs.readFileSync(runtimeFile, "utf8"))).toMatchObject({ provider: "codex", model: "gpt-test", effort: "medium" });

    fs.writeFileSync(runtimeFile, "{ truncated");
    const afterTruncated = await loadSessionRecord(id);
    expect(afterTruncated).toMatchObject({ provider: "codex", model: "gpt-test" });
    expect(afterTruncated.effort).toBeUndefined();

    // A well-formed file with wrong types must not reach the resumed run either.
    fs.writeFileSync(runtimeFile, JSON.stringify({ provider: 12, model: ["x"], effort: null, updatedAt: 1 }));
    const afterWrongTypes = await loadSessionRecord(id);
    expect(afterWrongTypes).toMatchObject({ provider: "codex", model: "gpt-test" });
    expect(afterWrongTypes.effort).toBeUndefined();

    fs.rmSync(runtimeFile);
    expect(await loadSessionRecord(id)).toMatchObject({ provider: "codex", model: "gpt-test" });
  });

  it("rewrites the runtime sidecar only when the run settings change", async () => {
    const id = "session_runtime_stable";
    await saveSession({ ...baseRecord(id), effort: "low" });
    const runtimeFile = path.join(path.dirname(sessionFilePath(id)), "runtime.json");
    const first = JSON.parse(fs.readFileSync(runtimeFile, "utf8")).updatedAt;
    await saveSession({ ...baseRecord(id), effort: "low", messages: [textMessage("user", "again")] });
    expect(JSON.parse(fs.readFileSync(runtimeFile, "utf8")).updatedAt).toBe(first);
  });

  it("whenSessionWritesSettle waits for an in-flight save to finish", async () => {
    const record = baseRecord("session_settle");
    const write = saveSession(record);
    // Settling must not resolve before the write does; a signal handler relies on
    // this to avoid killing the process mid-append and truncating session.jsonl.
    let writeFinished = false;
    void write.then(() => { writeFinished = true; });
    await whenSessionWritesSettle();
    expect(writeFinished).toBe(true);
    await write;
    expect(fs.existsSync(sessionFilePath("session_settle"))).toBe(true);
  });

  it("whenSessionWritesSettle resolves immediately when nothing is writing", async () => {
    await expect(whenSessionWritesSettle()).resolves.toBeUndefined();
  });
});
