import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { textMessage } from "../core/messages.js";
import { planSessionPrune } from "../core/session-prune.js";
import { saveSession, type SessionRecord } from "../core/session-store.js";

const originalHome = process.env.CREWCODER_HOME;
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-prune-"));
  process.env.CREWCODER_HOME = home;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
});

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function makeSession(id: string, startedAt: string): Promise<string> {
  await saveSession({
    id,
    startedAt,
    cwd: "/tmp/project",
    requestedMode: "general",
    resolvedMode: "general",
    prompt: `prompt ${id}`,
    events: [],
    messages: [textMessage("user", "hello")],
    mutationLog: []
  } satisfies SessionRecord);
  return path.join(home, "sessions", id);
}

function writeCheckpoint(sessionDir: string, bytes: number): void {
  const dir = path.join(sessionDir, "checkpoints", "checkpoint_1", "files");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "snapshot.txt"), "x".repeat(bytes), "utf8");
}

describe("session prune", () => {
  it("reports leftover artifacts without deleting them by default", async () => {
    const dir = await makeSession("session_a", daysAgo(1));
    fs.writeFileSync(path.join(dir, "session.jsonl.bloated.bak"), "x".repeat(5_000), "utf8");

    const plan = await planSessionPrune();

    expect(plan.applied).toBe(false);
    expect(plan.targets).toHaveLength(1);
    expect(plan.targets[0]).toMatchObject({ kind: "artifact", sessionId: "session_a", bytes: 5_000 });
    expect(fs.existsSync(path.join(dir, "session.jsonl.bloated.bak"))).toBe(true);
  });

  it("deletes artifacts only with apply, and never the session itself", async () => {
    const dir = await makeSession("session_a", daysAgo(1));
    fs.writeFileSync(path.join(dir, "session.jsonl.bloated.bak"), "x".repeat(5_000), "utf8");

    const plan = await planSessionPrune({ apply: true });

    expect(plan.applied).toBe(true);
    expect(plan.failures).toEqual([]);
    expect(fs.existsSync(path.join(dir, "session.jsonl.bloated.bak"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "session.jsonl"))).toBe(true);
  });

  it("never treats the session file or its checkpoints as artifacts", async () => {
    const dir = await makeSession("session_a", daysAgo(400));
    writeCheckpoint(dir, 1_000);

    const plan = await planSessionPrune({ artifacts: true });

    expect(plan.targets).toEqual([]);
  });

  it("requires an age threshold before pruning checkpoints or sessions", async () => {
    await makeSession("session_a", daysAgo(400));

    await expect(planSessionPrune({ checkpoints: true })).rejects.toThrow(/--older-than/);
    await expect(planSessionPrune({ sessions: true })).rejects.toThrow(/--older-than/);
  });

  it("prunes checkpoints by session age from the header, keeping the session", async () => {
    const old = await makeSession("session_old", daysAgo(60));
    const recent = await makeSession("session_recent", daysAgo(2));
    writeCheckpoint(old, 2_000);
    writeCheckpoint(recent, 2_000);

    const plan = await planSessionPrune({ checkpoints: true, olderThanDays: 30, apply: true });

    expect(plan.targets.map((t) => t.sessionId)).toEqual(["session_old"]);
    expect(fs.existsSync(path.join(old, "checkpoints"))).toBe(false);
    expect(fs.existsSync(path.join(old, "session.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(recent, "checkpoints"))).toBe(true);
  });

  it("prunes whole sessions older than the threshold and honors --keep", async () => {
    const old = await makeSession("session_old", daysAgo(60));
    const kept = await makeSession("session_kept", daysAgo(90));
    const recent = await makeSession("session_recent", daysAgo(2));

    const plan = await planSessionPrune({ sessions: true, olderThanDays: 30, keep: ["session_kept"], apply: true });

    expect(plan.targets.map((t) => t.sessionId)).toEqual(["session_old"]);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(recent)).toBe(true);
  });

  it("refuses to follow a symlink out of the sessions directory", async () => {
    const dir = await makeSession("session_a", daysAgo(1));
    const outside = path.join(home, "outside.txt");
    fs.writeFileSync(outside, "precious", "utf8");
    fs.symlinkSync(outside, path.join(dir, "link.bak"));

    const plan = await planSessionPrune({ apply: true });

    expect(plan.failures).toEqual([expect.objectContaining({ error: expect.stringContaining("symlink") })]);
    expect(fs.readFileSync(outside, "utf8")).toBe("precious");
  });

  it("reports nothing to prune on a clean store", async () => {
    await makeSession("session_a", daysAgo(1));

    const plan = await planSessionPrune();

    expect(plan.targets).toEqual([]);
    expect(plan.totalBytes).toBe(0);
    expect(plan.sessionsScanned).toBe(1);
  });
});
