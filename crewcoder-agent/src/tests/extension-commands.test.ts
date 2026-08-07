import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../core/config.js";
import { savePromptCommand } from "../core/prompt-command-store.js";
import { extensionCommandName, getAvailablePromptCommand, listAvailablePromptCommands, parsePromptCommandArgs } from "../extensions/extension-commands.js";

function withTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-ext-commands-"));
  process.env.CREWCODER_HOME = home;
  return home;
}

function writeExtension(home: string, id: string, contributes: Record<string, unknown>): void {
  const dir = path.join(home, "extensions", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "crewcoder.extension.json"), JSON.stringify({
    id,
    name: id,
    version: "0.1.0",
    crewcoder: { apiVersion: "0.1" },
    contributes
  }), "utf8");
}

describe("extension prompt commands", () => {
  it("generates namespaced prompt command names", () => {
    expect(extensionCommandName("review.pack", "security.audit")).toBe("ext.review_pack.security_audit");
  });

  it("lists local and enabled extension commands", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      savePromptCommand("fix-tests", "Fix failing tests.");
      writeExtension(home, "review-pack", {
        commands: [{ id: "security", title: "Security Review", description: "Review for security issues.", content: "Review this repo for security issues." }]
      });

      const commands = await listAvailablePromptCommands();
      expect(commands.map((command) => command.name)).toEqual(["ext.review-pack.security", "fix-tests"]);
      const extension = await getAvailablePromptCommand("ext.review-pack.security");
      expect(extension.source).toBe("extension");
      expect(extension.content).toBe("Review this repo for security issues.\n");
      expect(extension.description).toBe("Review for security issues.");
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("omits commands from disabled extensions", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      writeExtension(home, "disabled-pack", {
        commands: [{ id: "hidden", title: "Hidden", content: "Do not show." }]
      });
      writeConfig({ ...readConfig(), disabledExtensions: ["disabled-pack"] });
      expect(await listAvailablePromptCommands()).toHaveLength(0);
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("renders command arguments, defaults, and missing required metadata", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      writeExtension(home, "issue-pack", {
        commands: [{
          id: "fix",
          title: "Fix Issue",
          content: "Fix {{issue}} for {{area}}. Priority: {{arg:priority}}.",
          arguments: [
            { name: "issue", description: "Issue id", required: true },
            { name: "area", default: "backend" },
            { name: "priority", default: "normal" }
          ]
        }]
      });

      const rendered = await getAvailablePromptCommand("ext.issue-pack.fix", { issue: "#123" });
      expect(rendered.content).toBe("Fix #123 for backend. Priority: normal.\n");
      expect(rendered.arguments?.map((arg) => arg.name)).toEqual(["issue", "area", "priority"]);
      expect(rendered.missingArguments).toEqual([]);

      const missing = await getAvailablePromptCommand("ext.issue-pack.fix");
      expect(missing.content).toContain("{{issue}}");
      expect(missing.missingArguments).toEqual(["issue"]);
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("parses command key=value args", () => {
    expect(parsePromptCommandArgs(["issue=#123", "area=frontend"])).toEqual({ issue: "#123", area: "frontend" });
    expect(() => parsePromptCommandArgs(["bad"])).toThrow("key=value");
  });

  it("loads command content from files inside the extension directory only", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = withTempHome();
    try {
      const dir = path.join(home, "extensions", "file-pack");
      fs.mkdirSync(path.join(dir, "prompts"), { recursive: true });
      fs.writeFileSync(path.join(dir, "prompts", "review.md"), "Review from file.", "utf8");
      fs.writeFileSync(path.join(dir, "crewcoder.extension.json"), JSON.stringify({
        id: "file-pack",
        name: "file-pack",
        version: "0.1.0",
        crewcoder: { apiVersion: "0.1" },
        contributes: {
          commands: [
            { id: "review", title: "Review", file: "prompts/review.md" },
            { id: "escape", title: "Escape", file: "../outside.md" }
          ]
        }
      }), "utf8");

      const commands = await listAvailablePromptCommands();
      expect(commands.map((command) => command.name)).toEqual(["ext.file-pack.review"]);
      expect(commands[0]?.content).toBe("Review from file.\n");
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });
});
