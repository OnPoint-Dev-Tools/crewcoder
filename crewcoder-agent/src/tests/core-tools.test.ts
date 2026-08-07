import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolContext } from "../core/tool-types.js";
import { bashTool } from "../tools/bash.js";
import { editTool } from "../tools/edit.js";
import { listFilesTool } from "../tools/list-files.js";
import { readTool } from "../tools/read.js";
import { writeTool } from "../tools/write.js";
import { truncateToolOutputHead, truncateToolOutputTail } from "../tools/tool-output-limits.js";

function workspace(): { cwd: string; context: ToolContext } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-tools-"));
  return { cwd, context: { cwd, mode: "general", sessionId: "test", mutationLog: [] } };
}

describe("shared tool output limits", () => {
  it("keeps a bounded UTF-8 head and tail", () => {
    const text = Array.from({ length: 100 }, (_, index) => `${index}:${"é".repeat(100)}`).join("\n");
    const head = truncateToolOutputHead(text, { maxBytes: 1_000, maxLines: 10 });
    const tail = truncateToolOutputTail(text, { maxBytes: 1_000, maxLines: 10 });

    expect(head.truncated).toBe(true);
    expect(head.outputBytes).toBeLessThanOrEqual(1_000);
    expect(head.text).toContain("0:");
    expect(tail.outputBytes).toBeLessThanOrEqual(1_000);
    expect(tail.text).toContain("99:");
    expect(head.text).not.toContain("�");
    expect(tail.text).not.toContain("�");
  });
});

describe("session external directory grants", () => {
  it("allows file tools only inside explicitly granted external roots", async () => {
    const { cwd, context } = workspace();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-external-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-ungranted-"));
    fs.writeFileSync(path.join(external, "allowed.txt"), "allowed", "utf8");
    fs.writeFileSync(path.join(other, "denied.txt"), "denied", "utf8");
    context.externalDirectories = [external];

    const result = await readTool.execute(readTool.parse({ path: path.join(external, "allowed.txt") }), context);
    expect(result.content[0]?.text).toContain("allowed");
    await expect(readTool.execute(readTool.parse({ path: path.join(other, "denied.txt") }), context)).rejects.toThrow("outside the workspace and session external directories");
  });

  it("rejects symlinks that escape an allowed root", async () => {
    const { context } = workspace();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-external-link-"));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-external-target-"));
    fs.writeFileSync(path.join(other, "secret.txt"), "secret", "utf8");
    fs.symlinkSync(other, path.join(external, "escape"));
    context.externalDirectories = [external];

    await expect(readTool.execute(readTool.parse({ path: path.join(external, "escape", "secret.txt") }), context)).rejects.toThrow("outside the workspace and session external directories");
  });

  it("permits writes under a granted external root", async () => {
    const { context } = workspace();
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "crewcoder-external-write-"));
    context.externalDirectories = [external];

    await writeTool.execute(writeTool.parse({ path: path.join(external, "new.txt"), content: "created" }), context);
    expect(fs.readFileSync(path.join(external, "new.txt"), "utf8")).toBe("created");
    expect(context.mutationLog).toEqual([path.join(external, "new.txt")]);
  });
});

describe("read tool pagination", () => {
  it("reads a requested line range and provides the next offset", async () => {
    const { cwd, context } = workspace();
    fs.writeFileSync(path.join(cwd, "lines.txt"), "one\ntwo\nthree\nfour", "utf8");

    const result = await readTool.execute(readTool.parse({ path: "lines.txt", offset: 2, limit: 2 }), context);

    expect(result.content[0]?.text).toContain("two\nthree");
    expect(result.content[0]?.text).toContain("Use offset=4 to continue");
    expect(result.details).toMatchObject({ offset: 2, outputLines: 2, truncated: true });
  });

  it("hard-caps maxBytes at 50KB", () => {
    expect(readTool.parse({ path: "large.txt", maxBytes: 999_999 }).maxBytes).toBe(50 * 1024);
  });
});

describe("bash tool output", () => {
  it("returns a labeled 50KB tail instead of silently injecting large output", async () => {
    const { context } = workspace();
    const result = await bashTool.execute({ command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(70000))"`, timeoutMs: 5_000 }, context);
    const text = result.content[0]?.text ?? "";

    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(52_000);
    expect(text).toContain("Command output truncated");
    expect(result.details).toMatchObject({ truncated: true });
  });
});

describe("listFiles tool", () => {
  it("sorts results and reports the count limit", async () => {
    const { cwd, context } = workspace();
    fs.writeFileSync(path.join(cwd, "z.txt"), "z");
    fs.writeFileSync(path.join(cwd, "a.txt"), "a");
    fs.writeFileSync(path.join(cwd, "m.txt"), "m");

    const result = await listFilesTool.execute(listFilesTool.parse({ maxFiles: 2 }), context);

    expect(result.content[0]?.text).toContain("a.txt\nm.txt");
    expect(result.content[0]?.text).toContain("2 file limit reached");
    expect(result.details).toMatchObject({ count: 2, truncated: true });
  });
});

describe("edit tool ambiguity", () => {
  it("rejects a non-unique single replacement", async () => {
    const { cwd, context } = workspace();
    fs.writeFileSync(path.join(cwd, "duplicate.txt"), "same\nsame\n", "utf8");

    await expect(editTool.execute(editTool.parse({ path: "duplicate.txt", find: "same", replace: "next" }), context)).rejects.toThrow("Found 2 occurrences");
    expect(fs.readFileSync(path.join(cwd, "duplicate.txt"), "utf8")).toBe("same\nsame\n");
  });

  it("allows explicit replaceAll and reports the replacement count", async () => {
    const { cwd, context } = workspace();
    fs.writeFileSync(path.join(cwd, "duplicate.txt"), "same\nsame\n", "utf8");

    const result = await editTool.execute(editTool.parse({ path: "duplicate.txt", find: "same", replace: "next", replaceAll: true }), context);

    expect(fs.readFileSync(path.join(cwd, "duplicate.txt"), "utf8")).toBe("next\nnext\n");
    expect(result.details).toMatchObject({ replacements: 2 });
  });
});
