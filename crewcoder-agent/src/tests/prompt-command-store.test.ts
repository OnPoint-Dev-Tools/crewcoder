import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPromptCommand, listPromptCommands, savePromptCommand } from "../core/prompt-command-store.js";

describe("prompt command store", () => {
  it("saves flat markdown commands under ~/.crewcoder/commands", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const saved = savePromptCommand("fix-tests", "Fix the failing tests.");
      expect(saved.path).toBe(path.join(home, "commands", "fix-tests.md"));
      expect(getPromptCommand("fix-tests").content).toBe("Fix the failing tests.\n");
      expect(listPromptCommands().map((command) => command.name)).toEqual(["fix-tests"]);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("loads nested COMMAND.md commands", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const commandDir = path.join(home, "commands", "review");
      fs.mkdirSync(commandDir, { recursive: true });
      fs.writeFileSync(path.join(commandDir, "COMMAND.md"), "Review this patch.\n", "utf8");
      expect(getPromptCommand("review").content).toBe("Review this patch.\n");
      expect(listPromptCommands().map((command) => command.name)).toEqual(["review"]);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });
});
