import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionCheckpoint, listSessionCheckpoints, previewSessionCheckpointRestore, restoreSessionCheckpoint } from "../core/session-checkpoints.js";

describe("session filesystem checkpoints", () => {
  it("creates, lists, and restores a workspace snapshot", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-workspace-"));
    process.env.CREWCODER_HOME = home;
    try {
      fs.writeFileSync(path.join(cwd, "README.md"), "before", "utf8");
      fs.mkdirSync(path.join(cwd, "src"));
      fs.writeFileSync(path.join(cwd, "src", "a.ts"), "export const a = 1;", "utf8");

      const checkpoint = await createSessionCheckpoint({ sessionId: "session_test", cwd, reason: "Before write", toolCallId: "call_1", toolName: "write" });
      expect(checkpoint.fileCount).toBe(2);
      expect((await listSessionCheckpoints("session_test")).map((item) => item.id)).toEqual([checkpoint.id]);

      fs.writeFileSync(path.join(cwd, "README.md"), "after", "utf8");
      fs.writeFileSync(path.join(cwd, "created.txt"), "new", "utf8");
      fs.rmSync(path.join(cwd, "src", "a.ts"));

      const preview = await previewSessionCheckpointRestore("session_test", checkpoint.id);
      expect(preview.changedFiles).toEqual(["README.md"]);
      expect(preview.missingFiles).toEqual(["src/a.ts"]);
      expect(preview.restoreFiles).toEqual(["src/a.ts", "README.md"]);
      expect(preview.deleteFiles).toEqual(["created.txt"]);
      expect(preview.diffs[0]).toMatchObject({ path: "README.md", lines: ["-1: before", "+1: after"] });

      const restored = await restoreSessionCheckpoint("session_test", checkpoint.id);
      expect(restored.restoredFiles).toBe(2);
      expect(restored.deletedFiles).toBe(1);
      expect(fs.readFileSync(path.join(cwd, "README.md"), "utf8")).toBe("before");
      expect(fs.readFileSync(path.join(cwd, "src", "a.ts"), "utf8")).toBe("export const a = 1;");
      expect(fs.existsSync(path.join(cwd, "created.txt"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });

  it("retains only the ten newest checkpoints per session", async () => {
    const previousHome = process.env.CREWCODER_HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-home-"));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-workspace-"));
    process.env.CREWCODER_HOME = home;
    try {
      fs.writeFileSync(path.join(cwd, "tracked.txt"), "checkpoint source", "utf8");
      const created = [];
      for (let index = 0; index < 11; index++) {
        created.push(await createSessionCheckpoint({ sessionId: "session_retention", cwd, reason: `Checkpoint ${index + 1}` }));
      }

      const retained = await listSessionCheckpoints("session_retention");
      expect(retained).toHaveLength(10);
      expect(retained.map((checkpoint) => checkpoint.id)).toEqual(created.slice(1).map((checkpoint) => checkpoint.id));
      expect(fs.existsSync(created[0]!.path)).toBe(false);
      expect(fs.existsSync(created[10]!.path)).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.CREWCODER_HOME;
      else process.env.CREWCODER_HOME = previousHome;
    }
  });
});
