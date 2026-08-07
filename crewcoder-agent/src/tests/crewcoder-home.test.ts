import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCrewCoderHome } from "../core/crewcoder-home.js";
import { loadSession } from "../core/session-loader.js";
import { saveSession } from "../core/session-store.js";

const originalCrewCoderHome = process.env.CREWCODER_HOME;

afterEach(() => {
  if (originalCrewCoderHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalCrewCoderHome;
});

describe("CrewCoder home", () => {
  it("roots all state including sessions under CREWCODER_HOME", () => {
    const globalHome = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-root-"));
    process.env.CREWCODER_HOME = globalHome;
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-cwd-"));
    const originalCwd = process.cwd();
    process.chdir(cwd);
    try {
      const home = getCrewCoderHome();
      expect(home.root).toBe(path.resolve(globalHome));
      expect(home.extensionsDir).toBe(path.join(home.root, "extensions"));
      expect(home.sessionsDir).toBe(path.join(home.root, "sessions"));
      expect(home.systemPromptsDir).toBe(path.join(home.root, "system-prompts"));
      expect(home.commandsDir).toBe(path.join(home.root, "commands"));
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("saves and loads sessions from the CREWCODER_HOME sessions folder", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-session-cwd-"));
    const globalHome = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-global-home-"));
    process.env.CREWCODER_HOME = globalHome;

    await saveSession({
      id: "session_project",
      startedAt: new Date().toISOString(),
      cwd,
      requestedMode: "auto",
      resolvedMode: "general",
      prompt: "hello",
      events: [],
      messages: [],
      mutationLog: []
    });

    const projectFile = path.join(cwd, ".crewcoder", "sessions", "session_project", "session.jsonl");
    const globalFile = path.join(globalHome, "sessions", "session_project", "session.jsonl");
    expect(fs.existsSync(projectFile)).toBe(false);
    expect(fs.existsSync(globalFile)).toBe(true);
    await expect(loadSession("session_project")).resolves.toMatchObject({ id: "session_project", cwd });
  });
});
