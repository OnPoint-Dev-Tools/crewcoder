import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGoal, createSessionCheckpoint, saveGoal } from "@onpoint-dev-tools/crewcoder-agent";
import { CrewCoderAdmin, createCrewCoderSession, type CrewCoderRewindOptions, type IntegrationProfile } from "../index.js";

let root = "";
let previousHome: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-sdk-admin-"));
  previousHome = process.env.CREWCODER_HOME;
  process.env.CREWCODER_HOME = path.join(root, "home");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

describe("CrewCoderAdmin", () => {
  it("reads and validates global configuration", () => {
    const admin = new CrewCoderAdmin({ cwd: root });

    expect(admin.config.get().integrationProfile).toBe("standalone");
    expect(admin.config.set("defaultProvider", " custom-provider ").defaultProvider).toBe("custom-provider");
    expect(() => admin.config.set("maxIterations", "invalid")).toThrow(/maxIterations/);
  });

  it("reports profile precedence and updates project or user scope", () => {
    const admin = new CrewCoderAdmin({ cwd: root });

    expect(admin.profiles.get()).toMatchObject({ effective: "standalone", source: "user", user: "standalone" });
    expect(admin.profiles.use("crewcode", "user")).toMatchObject({ effective: "crewcode", source: "user", user: "crewcode" });
    expect(admin.profiles.use("standalone")).toMatchObject({
      effective: "standalone",
      source: "project",
      project: "standalone",
      user: "crewcode"
    });
  });

  it("detects CrewCode markers and persists prompt dismissal", () => {
    fs.writeFileSync(path.join(root, "crewcode.plugin.json"), "{}\n", "utf8");
    const admin = new CrewCoderAdmin({ cwd: root });

    expect(admin.profiles.detect()).toMatchObject({ detected: true, dismissed: false, shouldPrompt: true });
    expect(admin.profiles.dismiss()).toMatchObject({ detected: true, dismissed: true, shouldPrompt: false });
  });

  it("rejects invalid profile values from untyped JavaScript callers", () => {
    const admin = new CrewCoderAdmin({ cwd: root });

    expect(() => admin.profiles.use("invalid" as IntegrationProfile)).toThrow(/standalone, crewcode/);
    expect(fs.existsSync(path.join(root, "crewcoder.json"))).toBe(false);
  });

  it("installs extensions prompt-only and manages explicit trust separately", async () => {
    const source = path.join(root, "extension-source");
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, "crewcoder.extension.json"), JSON.stringify({ id: "sdk-test", name: "SDK Test", version: "1.0.0", crewcoder: { apiVersion: "0.1" }, contributes: { tools: [{ id: "test", title: "Test", name: "test", description: "test", command: "echo" }] } }), "utf8");
    const admin = new CrewCoderAdmin({ cwd: root });

    const installed = await admin.extensions.install(source);
    expect(installed.id).toBe("sdk-test");
    expect(admin.extensions.getTrust("sdk-test")).toBe("prompt-only");
    expect((await admin.extensions.inspect("sdk-test"))?.manifest.id).toBe("sdk-test");
    expect(admin.extensions.setTrust("sdk-test", "sandboxed")).toBe("sandboxed");
    expect((await admin.extensions.list()).map((item) => item.manifest.id)).toContain("sdk-test");
    expect((await admin.extensions.remove("sdk-test")).id).toBe("sdk-test");
    expect(await admin.extensions.inspect("sdk-test")).toBeUndefined();
  });

  it("lists and controls detached goal records for its workspace", async () => {
    const other = path.join(root, "other-goal-workspace");
    fs.mkdirSync(other);
    const goal = await createGoal({ objective: "Ship verified change", cwd: root, provider: "codex", model: "test", mode: "general", approvalMode: "review" });
    const otherGoal = await createGoal({ objective: "Other", cwd: other, provider: "codex", model: "test", mode: "general", approvalMode: "review" });
    const admin = new CrewCoderAdmin({ cwd: root });

    expect((await admin.goals.list()).map((item) => item.id)).toEqual([goal.id]);
    expect((await admin.goals.list({ all: true })).map((item) => item.id).sort()).toEqual([goal.id, otherGoal.id].sort());
    expect((await admin.goals.current())?.id).toBe(goal.id);
    expect((await admin.goals.pause(goal.id, "Host paused")).status).toBe("paused");
    await saveGoal({ ...(await admin.goals.get(goal.id)), status: "awaiting_approval", pendingApproval: { approvalId: "approval_1", toolCallId: "call_1", toolName: "write", reason: "Review", args: {} } });
    expect((await admin.goals.approve(goal.id, true, "Host approved")).pendingApproval?.decision).toEqual({ approved: true, reason: "Host approved" });
    expect((await admin.goals.cancel(goal.id)).status).toBe("cancelled");
    await expect(admin.goals.get("../goal_bad")).rejects.toThrow(/Invalid goal id/);
  });

  it("manages opt-in repository memory", () => {
    const admin = new CrewCoderAdmin({ cwd: root });

    expect(admin.memory.status()).toEqual({ enabled: false });
    expect(() => admin.memory.remember("Do not persist yet")).toThrow(/memory is off/i);
    expect(admin.memory.setEnabled(true)).toEqual({ enabled: true });
    const entry = admin.memory.remember("Use deterministic fixtures", { topic: "Testing Notes" });
    expect(entry.topic).toBe("testing-notes");
    expect(admin.memory.list()).toEqual([entry]);
    expect(admin.memory.context()).toContain("Use deterministic fixtures");
    expect(admin.memory.forget(entry.id)?.id).toBe(entry.id);
    expect(admin.memory.forget(entry.id)).toBeNull();
  });

  it("lists, gets, branches, and deletes durable project sessions", async () => {
    const workspace = path.join(root, "workspace");
    fs.mkdirSync(workspace);
    const session = createCrewCoderSession({ cwd: workspace, heuristic: true });
    const result = await session.prompt("Inspect the project");
    const admin = new CrewCoderAdmin({ cwd: workspace });

    // Default listings are header-only and omit messageCount, which needs a full parse.
    const headerOnly = await admin.sessions.list();
    expect(headerOnly).toEqual([expect.objectContaining({ id: result.sessionId, cwd: workspace })]);
    expect(headerOnly[0]).not.toHaveProperty("messageCount");
    expect(await admin.sessions.list({ cwd: workspace, includeMessageCount: true })).toEqual([
      expect.objectContaining({ id: result.sessionId, cwd: workspace, messageCount: result.messages.length })
    ]);
    expect((await admin.sessions.get(result.sessionId)).messages).toHaveLength(result.messages.length);

    const branch = await admin.sessions.branch(result.sessionId);
    expect(branch.id).not.toBe(result.sessionId);
    expect(branch.parentSessionId).toBe(result.sessionId);
    expect(await admin.sessions.delete(branch.id)).toBe(true);
    expect(await admin.sessions.delete(branch.id)).toBe(false);
  });

  it("previews and explicitly confirms a workspace rewind with durable audit", async () => {
    const workspace = path.join(root, "rewind-workspace");
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, "tracked.txt"), "before", "utf8");
    const session = await createCrewCoderSession({ cwd: workspace, heuristic: true }).prompt("checkpoint test");
    const checkpoint = await createSessionCheckpoint({ sessionId: session.sessionId, cwd: workspace, reason: "SDK test" });
    fs.writeFileSync(path.join(workspace, "tracked.txt"), "after", "utf8");
    fs.writeFileSync(path.join(workspace, "remove.txt"), "remove", "utf8");
    const admin = new CrewCoderAdmin({ cwd: workspace });

    expect(await admin.sessions.checkpoints(session.sessionId)).toEqual([checkpoint]);
    expect(await admin.sessions.previewRewind(session.sessionId, checkpoint.id)).toMatchObject({
      changedFiles: ["tracked.txt"],
      deleteFiles: ["remove.txt"]
    });
    expect(() => admin.sessions.rewind(session.sessionId, checkpoint.id, {} as CrewCoderRewindOptions)).toThrow(/confirm/);
    expect(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8")).toBe("after");

    const result = await admin.sessions.rewind(session.sessionId, checkpoint.id, { confirm: true });
    expect(result.audit).toMatchObject({ sessionId: session.sessionId, checkpointId: checkpoint.id, restoredFiles: 1, deletedFiles: 1 });
    expect(fs.readFileSync(path.join(workspace, "tracked.txt"), "utf8")).toBe("before");
    expect(fs.existsSync(path.join(workspace, "remove.txt"))).toBe(false);
    expect((await admin.sessions.get(session.sessionId)).checkpointRestores).toEqual([result.audit]);
  });

  it("blocks checkpoint restore through workspace symlinks", async () => {
    const workspace = path.join(root, "symlink-workspace");
    const outside = path.join(root, "symlink-outside");
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.mkdirSync(path.join(workspace, "src"));
    fs.writeFileSync(path.join(workspace, "src", "tracked.txt"), "snapshot", "utf8");
    const session = await createCrewCoderSession({ cwd: workspace, heuristic: true }).prompt("symlink checkpoint test");
    const checkpoint = await createSessionCheckpoint({ sessionId: session.sessionId, cwd: workspace, reason: "SDK symlink test" });
    fs.rmSync(path.join(workspace, "src"), { recursive: true });
    fs.symlinkSync(outside, path.join(workspace, "src"), "dir");
    const admin = new CrewCoderAdmin({ cwd: workspace });

    await expect(admin.sessions.rewind(session.sessionId, checkpoint.id, { confirm: true })).rejects.toThrow(/symbolic-link/);
    expect(fs.existsSync(path.join(outside, "tracked.txt"))).toBe(false);
  });

  it("rejects malformed checkpoint ids before workspace mutation", async () => {
    const admin = new CrewCoderAdmin({ cwd: root });
    const sentinel = path.join(root, "sentinel.txt");
    fs.writeFileSync(sentinel, "keep", "utf8");

    await expect(admin.sessions.rewind("session_safe", "../checkpoint_bad", { confirm: true })).rejects.toThrow(/Checkpoint id/);
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  });

  it("lists all sessions only when explicitly requested and blocks traversal deletion", async () => {
    const firstWorkspace = path.join(root, "first");
    const secondWorkspace = path.join(root, "second");
    fs.mkdirSync(firstWorkspace);
    fs.mkdirSync(secondWorkspace);
    await createCrewCoderSession({ cwd: firstWorkspace, heuristic: true }).prompt("first");
    await createCrewCoderSession({ cwd: secondWorkspace, heuristic: true }).prompt("second");
    const admin = new CrewCoderAdmin({ cwd: firstWorkspace });
    const sentinel = path.join(process.env.CREWCODER_HOME ?? "", "sentinel.txt");
    fs.writeFileSync(sentinel, "keep", "utf8");

    expect(await admin.sessions.list()).toHaveLength(1);
    expect(await admin.sessions.list({})).toHaveLength(2);
    await expect(admin.sessions.delete("../sentinel.txt")).rejects.toThrow(/Session id/);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep", "utf8");
    fs.symlinkSync(outside, path.join(process.env.CREWCODER_HOME ?? "", "sessions", "linked_session"), "dir");
    await expect(admin.sessions.delete("linked_session")).rejects.toThrow(/not a real directory/);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
    expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
  });
});
