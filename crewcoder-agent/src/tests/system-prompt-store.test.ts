import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSystemPrompt, getSystemPromptPath, listSystemPrompts, saveSystemPrompt } from "../core/system-prompt-store.js";

describe("system prompt store", () => {
  it("saves prompts under system-prompts/<name>/SYSTEM-PROMPT.md", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const originalHome = process.env.CREWCODER_HOME;
    process.env.CREWCODER_HOME = home;
    try {
      const saved = saveSystemPrompt("frontend-review", "Prefer direct implementation.");
      expect(saved.path).toBe(path.join(home, "system-prompts", "frontend-review", "SYSTEM-PROMPT.md"));
      expect(fs.readFileSync(saved.path, "utf8")).toBe("Prefer direct implementation.\n");
      expect(getSystemPrompt("frontend-review").content).toContain("Prefer direct implementation.");
      expect(getSystemPromptPath("frontend-review")).toBe(saved.path);
      expect(listSystemPrompts().map((prompt) => prompt.name)).toEqual(["frontend-review"]);
    } finally {
      if (originalHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = originalHome;
    }
  });

  it("rejects path-like prompt names", () => {
    expect(() => saveSystemPrompt("../escape", "nope")).toThrow(/may only contain/);
  });
});
