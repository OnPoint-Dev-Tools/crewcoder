import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProjectFolder } from "../core/native-session-files.js";
import { exportSessionBundle, importSessionBundle, movedSessionNote, SessionBundleError } from "../core/session-bundle.js";
import { createSessionId, getSessionDir, loadSessionRecord, saveSession, sessionRuntimeFilePath, type SessionRecord } from "../core/session-store.js";

const record = (id: string): SessionRecord => ({
  id,
  startedAt: new Date(0).toISOString(),
  cwd: "/home/cj/dev/app",
  externalDirectories: ["/home/cj/shared"],
  providerSessionIds: { claude: "claude-native-1", codex: "thread-1" },
  requestedMode: "general",
  resolvedMode: "general",
  prompt: "start",
  provider: "claude",
  model: "claude-haiku-4-5",
  events: [],
  messages: [
    { role: "user", content: [{ type: "text", text: "start" }], timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "done on the pc" }], stopReason: "end", timestamp: 2 }
  ] as SessionRecord["messages"],
  mutationLog: []
});

const scratch = () => fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-bundle-"));

describe("session bundles", () => {
  it("round-trips a session, clearing native provider ids and noting the new workspace path", async () => {
    const id = createSessionId();
    await saveSession(record(id));
    const dir = await scratch();
    const bundle = path.join(dir, "move.ccbundle");
    const exported = await exportSessionBundle(id, bundle);
    expect(exported.bytes).toBeGreaterThan(0);
    await expect(exportSessionBundle(id, bundle)).rejects.toThrow(/EEXIST/);

    // Simulate the destination: same id absent, then import.
    await fs.rm(getSessionDir(id), { recursive: true });
    const imported = await importSessionBundle(bundle, { cwd: "/srv/work/app" });
    expect(imported).toMatchObject({ sessionId: id, messages: 2, replaced: false });

    const loaded = await loadSessionRecord(id);
    expect(loaded.cwd).toBe(path.resolve("/srv/work/app"));
    expect(loaded.messages.map((message) => message.content)).toEqual(record(id).messages.map((message) => message.content));
    expect(loaded.providerSessionIds).toEqual({});
    expect(loaded.externalDirectories).toEqual([]);
    expect(loaded.pendingMoveNote).toContain("/srv/work/app");
    expect(loaded.pendingMoveNote).toContain("/home/cj/dev/app");
    expect(loaded.pendingMoveNote).toContain("stayed behind");
    expect(JSON.parse(await fs.readFile(sessionRuntimeFilePath(id), "utf8")).model).toBe("claude-haiku-4-5");
  });

  it("refuses to overwrite an existing session unless asked, and then keeps a backup", async () => {
    const id = createSessionId();
    await saveSession(record(id));
    const bundle = path.join(await scratch(), "move.ccbundle");
    await exportSessionBundle(id, bundle);
    await expect(importSessionBundle(bundle)).rejects.toMatchObject({ code: "SESSION_EXISTS" });
    const replaced = await importSessionBundle(bundle, { replace: true });
    expect(replaced.replaced).toBe(true);
    expect(await fs.stat(path.join(replaced.backupPath!, "session.jsonl"))).toBeTruthy();
    const kept = await loadSessionRecord(id);
    expect(kept.cwd).toBe("/home/cj/dev/app");
    expect(kept.messages).toHaveLength(2);
  });

  it("rejects files that are not bundles and ids that are paths", async () => {
    const dir = await scratch();
    const notBundle = path.join(dir, "plain.gz");
    await fs.writeFile(notBundle, gzipSync('{"hello":true}\n'));
    await expect(importSessionBundle(notBundle)).rejects.toBeInstanceOf(SessionBundleError);

    const id = createSessionId();
    await saveSession(record(id));
    const good = path.join(dir, "good.ccbundle");
    await exportSessionBundle(id, good);
    const [header, ...rest] = gunzipSync(await fs.readFile(good)).toString("utf8").split("\n");
    const evil = path.join(dir, "evil.ccbundle");
    await fs.writeFile(evil, gzipSync([JSON.stringify({ ...JSON.parse(header!), sessionId: "../../outside" }), ...rest].join("\n")));
    await expect(importSessionBundle(evil)).rejects.toThrow(/invalid session id/);
    await expect(exportSessionBundle("../etc", path.join(dir, "x"))).rejects.toThrow(/invalid session id/);
  });

  it("only mentions a path change when the workspace actually moved", () => {
    const header = { format: "crewcoder-session-bundle", version: 1, sessionId: "s", exportedAt: "", sourceCwd: "/a", sourceHost: "pc", crewcoderVersion: "x" } as const;
    expect(movedSessionNote(header, "/a")).not.toContain("is now at");
    expect(movedSessionNote(header, "/b")).toContain("is now at /b");
  });
});

describe("session bundles with provider-native sessions", () => {
  const original = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  afterEach(() => {
    if (original.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = original.claude;
    if (original.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = original.codex;
  });
  const CLAUDE_ID = "2b54544e-df8d-4318-8fd9-f6c1da640858";
  const THREAD = "01a11750-bcbe-7690-9f82-c2fa2a1310c6";
  const ROLLOUT = `sessions/2026/10/07/rollout-2026-10-07T13-02-10-${THREAD}.jsonl`;
  const machine = async () => {
    const root = await scratch();
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
    process.env.CODEX_HOME = path.join(root, "codex");
    return { claude: path.join(root, "claude"), codex: path.join(root, "codex") };
  };
  const nativeRecord = (id: string): SessionRecord => ({ ...record(id), providerSessionIds: { claude: CLAUDE_ID, "codex-cli": `codex-thread-v1:abc123:${THREAD}`, opencode: "elsewhere" } });

  it("carries Claude and Codex sessions so they continue natively on the new machine", async () => {
    const pc = await machine();
    const claudeFile = path.join(pc.claude, "projects", claudeProjectFolder("/home/cj/dev/app"), `${CLAUDE_ID}.jsonl`);
    const codexFile = path.join(pc.codex, ...ROLLOUT.split("/"));
    await fs.mkdir(path.dirname(claudeFile), { recursive: true });
    await fs.mkdir(path.dirname(codexFile), { recursive: true });
    await fs.writeFile(claudeFile, '{"type":"user","text":"PELICAN-42"}\n{"type":"assistant"}\n');
    await fs.writeFile(codexFile, '{"type":"session_meta","payload":{"id":"x"}}\n');
    const id = createSessionId();
    await saveSession(nativeRecord(id));
    const bundle = path.join(await scratch(), "move.ccbundle");
    expect((await exportSessionBundle(id, bundle)).native.sort()).toEqual(["claude", "codex-cli"]);

    await fs.rm(getSessionDir(id), { recursive: true });
    const vps = await machine();
    const imported = await importSessionBundle(bundle, { cwd: "/srv/work/app" });
    expect(imported.native.sort()).toEqual(["claude", "codex-cli"]);
    expect(await fs.readFile(path.join(vps.claude, "projects", "-srv-work-app", `${CLAUDE_ID}.jsonl`), "utf8")).toBe(await fs.readFile(claudeFile, "utf8"));
    expect(await fs.readFile(path.join(vps.codex, ...ROLLOUT.split("/")), "utf8")).toBe(await fs.readFile(codexFile, "utf8"));
    const loaded = await loadSessionRecord(id);
    expect(loaded.providerSessionIds).toEqual({ claude: CLAUDE_ID, "codex-cli": `codex-thread-v1:abc123:${THREAD}` });
    expect(loaded.pendingMoveNote).toContain("continues with its full history");
    expect(loaded.messages).toHaveLength(2);
  });

  it("taking a session back backs up the stale native copies instead of leaving two live ones", async () => {
    const pc = await machine();
    const stale = path.join(pc.claude, "projects", claudeProjectFolder("/home/cj/dev/app"), `${CLAUDE_ID}.jsonl`);
    const elsewhere = path.join(pc.claude, "projects", "-some-other-folder", `${CLAUDE_ID}.jsonl`);
    for (const file of [stale, elsewhere]) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, '{"old":true}\n'); }
    const id = createSessionId();
    await saveSession(nativeRecord(id));

    // The VPS copy grew while the PC copy sat still.
    const vps = await machine();
    const live = path.join(vps.claude, "projects", "-srv-work-app", `${CLAUDE_ID}.jsonl`);
    await fs.mkdir(path.dirname(live), { recursive: true });
    await fs.writeFile(live, '{"old":true}\n{"new":"from the phone"}\n');
    const bundle = path.join(await scratch(), "back.ccbundle");
    expect((await exportSessionBundle(id, bundle)).native).toEqual(["claude"]);

    process.env.CLAUDE_CONFIG_DIR = pc.claude;
    process.env.CODEX_HOME = pc.codex;
    const back = await importSessionBundle(bundle, { cwd: "/home/cj/dev/app", replace: true });
    expect(back.native).toEqual(["claude"]);
    expect(await fs.readFile(stale, "utf8")).toContain("from the phone");
    await expect(fs.stat(elsewhere)).rejects.toThrow();
    const backups = path.join(process.env.CREWCODER_HOME!, "backups", "native", "claude");
    const saved = (await Promise.all((await fs.readdir(backups)).map((dir) => fs.readdir(path.join(backups, dir))))).flat();
    expect(saved.filter((name) => name.endsWith(`${CLAUDE_ID}.jsonl`)).length).toBeGreaterThanOrEqual(2);
    expect((await loadSessionRecord(id)).providerSessionIds).toEqual({ claude: CLAUDE_ID });
  });

  it("still imports version 1 bundles, which carry no native sessions", async () => {
    await machine();
    const id = createSessionId();
    await saveSession(record(id));
    const v1 = path.join(await scratch(), "v1.ccbundle");
    const header = { format: "crewcoder-session-bundle", version: 1, sessionId: id, exportedAt: "", sourceCwd: "/home/cj/dev/app", sourceHost: "pc", crewcoderVersion: "0.7.0" };
    await fs.writeFile(v1, gzipSync(Buffer.concat([Buffer.from(`${JSON.stringify(header)}\n`), await fs.readFile(path.join(getSessionDir(id), "session.jsonl"))])));
    await fs.rm(getSessionDir(id), { recursive: true });
    const imported = await importSessionBundle(v1);
    expect(imported).toMatchObject({ sessionId: id, native: [] });
    expect((await loadSessionRecord(id)).providerSessionIds).toEqual({});
  });

  it("rejects native entries that point outside the provider folders or lengths that do not add up", async () => {
    await machine();
    const id = createSessionId();
    await saveSession(record(id));
    const good = path.join(await scratch(), "good.ccbundle");
    await exportSessionBundle(id, good);
    const [line, ...rest] = gunzipSync(await fs.readFile(good)).toString("utf8").split("\n");
    const header = JSON.parse(line!);
    const rewrite = async (patch: Record<string, unknown>) => {
      const file = path.join(await scratch(), "bad.ccbundle");
      await fs.writeFile(file, gzipSync([JSON.stringify({ ...header, ...patch }), ...rest].join("\n")));
      return file;
    };
    await fs.rm(getSessionDir(id), { recursive: true });
    const escape = await rewrite({ native: [{ provider: "codex-cli", providerSessionId: `codex-thread-v1:a:${THREAD}`, relativePath: `sessions/../../../.ssh/rollout-x-${THREAD}.jsonl`, bytes: 0 }] });
    await expect(importSessionBundle(escape)).rejects.toMatchObject({ code: "INVALID_BUNDLE" });
    const wrongName = await rewrite({ native: [{ provider: "claude", providerSessionId: CLAUDE_ID, relativePath: "../settings.json", bytes: 0 }] });
    await expect(importSessionBundle(wrongName)).rejects.toMatchObject({ code: "INVALID_BUNDLE" });
    const short = await rewrite({ sessionBytes: header.sessionBytes + 10 });
    await expect(importSessionBundle(short)).rejects.toThrow(/truncated/);
    const foreign = await rewrite({ native: [{ provider: "claude", providerSessionId: CLAUDE_ID, relativePath: `${CLAUDE_ID}.jsonl`, bytes: 0 }] });
    await expect(importSessionBundle(foreign)).rejects.toThrow(/does not belong/);
  });
});
