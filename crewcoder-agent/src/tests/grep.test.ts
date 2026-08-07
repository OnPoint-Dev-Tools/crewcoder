import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { grepTool } from "../tools/grep.js";
import type { ToolContext } from "../core/tool-types.js";

function workspace(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-grep-"));
  fs.writeFileSync(path.join(cwd, "cli.ts"), "export const cli = 1;\nfunction listExtensions() {}\n");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src", "app.ts"), "const listExtensions = 2;\n");
  fs.writeFileSync(path.join(cwd, "notes.log"), "listExtensions in an unindexed extension\n");
  return cwd;
}

function context(cwd: string): ToolContext {
  return { cwd, mode: "general", sessionId: "test", mutationLog: [] };
}

function run(cwd: string, args: Record<string, unknown>) {
  return grepTool.execute(grepTool.parse(args), context(cwd));
}

describe("grep tool", () => {
  it("searches a single file path without ENOTDIR", async () => {
    const cwd = workspace();
    const result = await run(cwd, { pattern: "listExtensions", path: "cli.ts" });

    expect(result.content[0]?.text).toContain("cli.ts:2:");
    expect(result.details).toMatchObject({ count: 1 });
  });

  it("searches a directory recursively", async () => {
    const cwd = workspace();
    const result = await run(cwd, { pattern: "listExtensions" });
    const text = result.content[0]?.text ?? "";

    expect(text).toContain("cli.ts:2:");
    expect(text).toContain(path.join("src", "app.ts"));
  });

  it("searches an explicitly named file even when its extension is not indexed", async () => {
    const cwd = workspace();
    const treeScan = await run(cwd, { pattern: "unindexed" });
    expect(treeScan.content[0]?.text).toBe("(no matches)");

    const direct = await run(cwd, { pattern: "unindexed", path: "notes.log" });
    expect(direct.content[0]?.text).toContain("notes.log:1:");
  });

  it("bounds a single enormous matching line", async () => {
    const cwd = workspace();
    fs.writeFileSync(path.join(cwd, "generated.json"), `needle${"x".repeat(2_200_000)}\n`);

    const result = await run(cwd, { pattern: "needle", path: "generated.json" });
    const text = result.content[0]?.text ?? "";

    expect(text.length).toBeLessThan(3_000);
    expect(text).toContain("needle");
    expect(result.details).toMatchObject({ count: 1, truncated: true });
  });

  it("caps aggregate output even when many bounded lines match", async () => {
    const cwd = workspace();
    fs.writeFileSync(path.join(cwd, "many.txt"), Array.from({ length: 100 }, (_, index) => `needle-${index}-${"x".repeat(1_500)}`).join("\n"));

    const result = await run(cwd, { pattern: "needle", path: "many.txt", maxMatches: 100 });
    const text = result.content[0]?.text ?? "";

    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(52_000);
    expect(text).toContain("50KB output limit reached;");
    expect(result.details).toMatchObject({ count: 100, truncated: true });
  });

  it("reports a missing path clearly instead of a raw fs error", async () => {
    const cwd = workspace();
    await expect(run(cwd, { pattern: "x", path: "nope.ts" })).rejects.toThrow("Path not found: nope.ts");
  });

  it("reports an invalid regex clearly", async () => {
    const cwd = workspace();
    await expect(run(cwd, { pattern: "list(" })).rejects.toThrow("Invalid regular expression");
  });

  it("returns no matches rather than failing when nothing matches", async () => {
    const cwd = workspace();
    const result = await run(cwd, { pattern: "zzz-not-here" });

    expect(result.content[0]?.text).toBe("(no matches)");
    expect(result.details).toMatchObject({ count: 0 });
  });
});
