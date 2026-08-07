import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../core/config.js";
import { extensionFileTriggersFromManifest, loadTrustedExtensionFileTriggers, runExtensionFileTriggers } from "../extensions/extension-file-triggers.js";
import type { LoadedCrewCoderExtension } from "../extensions/types.js";

function loadedExtension(partial: Partial<LoadedCrewCoderExtension["manifest"]> & { id: string }): LoadedCrewCoderExtension {
  return {
    dir: `/tmp/${partial.id}`,
    warnings: [],
    manifest: {
      id: partial.id,
      name: partial.name ?? partial.id,
      version: partial.version ?? "0.1.0",
      crewcoder: { apiVersion: "0.1" },
      contributes: partial.contributes
    }
  };
}

describe("extension file triggers", () => {
  it("normalizes manifest file triggers", () => {
    const triggers = extensionFileTriggersFromManifest(loadedExtension({
      id: "docs-pack",
      contributes: { fileTriggers: [{ id: "docs", title: "Docs", patterns: ["docs/**/*.md"], command: process.execPath, args: ["script.js"], env: { A: "B" } }] }
    }));

    expect(triggers).toMatchObject([{ extensionId: "docs-pack", triggerId: "docs", patterns: ["docs/**/*.md"], command: process.execPath, args: ["script.js"], env: { A: "B" } }]);
  });

  it("loads triggers only when hooks are allowed and extension is trusted", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-file-triggers-"));
    process.env.CREWCODER_HOME = home;
    try {
      const extensionDir = path.join(home, "extensions", "trusted-triggers");
      fs.mkdirSync(extensionDir, { recursive: true });
      fs.writeFileSync(path.join(extensionDir, "crewcoder.extension.json"), JSON.stringify({
        id: "trusted-triggers",
        name: "Trusted Triggers",
        version: "0.1.0",
        crewcoder: { apiVersion: "0.1" },
        contributes: { fileTriggers: [{ id: "docs", title: "Docs", patterns: ["docs/**/*.md"], command: process.execPath }] }
      }), "utf8");

      expect(await loadTrustedExtensionFileTriggers()).toHaveLength(0);
      writeConfig({ ...readConfig(), allowExtensionHooks: true, trustedExtensions: ["trusted-triggers"] });
      expect((await loadTrustedExtensionFileTriggers()).map((trigger) => trigger.triggerId)).toEqual(["docs"]);
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("runs matching triggers with templated payload values", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-file-trigger-run-"));
    const marker = path.join(cwd, "marker.txt");
    const triggers = extensionFileTriggersFromManifest(loadedExtension({
      id: "docs-pack",
      contributes: { fileTriggers: [{ id: "docs", title: "Docs", patterns: ["docs/**/*.md"], command: process.execPath, args: ["-e", `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(marker)}, process.argv[1] + '|' + process.env.TRIGGER_PATH, 'utf8')`, "{{path}}"], env: { TRIGGER_PATH: "{{path}}" } }] }
    }));

    const results = await runExtensionFileTriggers(triggers, { path: "docs/guide/intro.md", toolName: "write", cwd, sessionId: "s1" });

    expect(results).toMatchObject([{ matched: true }]);
    expect(fs.readFileSync(marker, "utf8")).toBe("docs/guide/intro.md|docs/guide/intro.md");
  });

  it("skips non-matching triggers", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-file-trigger-skip-"));
    const triggers = extensionFileTriggersFromManifest(loadedExtension({
      id: "docs-pack",
      contributes: { fileTriggers: [{ id: "docs", title: "Docs", patterns: ["docs/**/*.md"], command: process.execPath }] }
    }));

    await expect(runExtensionFileTriggers(triggers, { path: "src/app.ts", toolName: "write", cwd, sessionId: "s1" })).resolves.toMatchObject([{ matched: false }]);
  });
});
