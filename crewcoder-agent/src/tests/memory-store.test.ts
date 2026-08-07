import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { forgetMemory, isProjectMemoryEnabled, listMemories, readMemoryContext, rememberFact, resolveMemoryDir, resolveMemorySettingsPath, setProjectMemoryEnabled } from "../core/memory-store.js";

let cwd: string;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-memory-"));
  setProjectMemoryEnabled(cwd, true);
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("cross-session memory", () => {
  it("defaults to off when a project has no memory setting", () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-memory-fresh-"));
    try {
      expect(isProjectMemoryEnabled(fresh)).toBe(false);
      expect(readMemoryContext(fresh)).toBeNull();
      expect(() => rememberFact(fresh, "Do not save by default")).toThrow("Project memory is off");
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("persists facts to repo-local .crewcoder/memory and lists them", () => {
    const entry = rememberFact(cwd, "Use tabs for indentation");
    expect(entry.topic).toBe("memory");
    expect(resolveMemoryDir(cwd)).toBe(path.join(cwd, ".crewcoder", "memory"));
    expect(fs.existsSync(path.join(cwd, ".crewcoder", "memory", "memory.md"))).toBe(true);

    const entries = listMemories(cwd);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe("Use tabs for indentation");
    expect(entries[0]?.id).toBe(entry.id);
  });

  it("groups facts by topic and injects them into context", () => {
    rememberFact(cwd, "Prefer pnpm", { topic: "tooling" });
    rememberFact(cwd, "API base is /v2", { topic: "api" });
    const context = readMemoryContext(cwd);
    expect(context).toContain("tooling:");
    expect(context).toContain("Prefer pnpm");
    expect(context).toContain("api:");
    expect(context).toContain("API base is /v2");
  });

  it("forgets a fact by id", () => {
    const keep = rememberFact(cwd, "keep this");
    const drop = rememberFact(cwd, "drop this");
    const removed = forgetMemory(cwd, drop.id);
    expect(removed?.id).toBe(drop.id);
    const remaining = listMemories(cwd).map((entry) => entry.id);
    expect(remaining).toEqual([keep.id]);
    expect(forgetMemory(cwd, "nonexistent")).toBeNull();
  });

  it("returns null context and empty list when nothing is remembered", () => {
    expect(readMemoryContext(cwd)).toBeNull();
    expect(listMemories(cwd)).toEqual([]);
  });

  it("rejects empty facts", () => {
    expect(() => rememberFact(cwd, "   ")).toThrow();
  });

  it("toggles memory per project without deleting existing facts", () => {
    rememberFact(cwd, "Keep this project convention");
    expect(isProjectMemoryEnabled(cwd)).toBe(true);

    const settings = setProjectMemoryEnabled(cwd, false);
    expect(settings).toBe(resolveMemorySettingsPath(cwd));
    expect(isProjectMemoryEnabled(cwd)).toBe(false);
    expect(readMemoryContext(cwd)).toBeNull();
    expect(() => rememberFact(cwd, "Do not save this")).toThrow("Project memory is off");
    expect(listMemories(cwd)).toHaveLength(1);

    setProjectMemoryEnabled(cwd, true);
    expect(readMemoryContext(cwd)).toContain("Keep this project convention");
  });
});
