import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { editTransactionTool } from "../tools/edit-transaction.js";

async function workspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-transaction-"));
}

const context = (cwd: string) => ({ cwd, mode: "general" as const, sessionId: "test", mutationLog: [] as string[] });

describe("edit_transaction tool", () => {
  it("previews and commits multiple files", async () => {
    const cwd = await workspace();
    await fs.writeFile(path.join(cwd, "a.txt"), "alpha\n");
    await fs.writeFile(path.join(cwd, "b.txt"), "beta beta\n");
    const ctx = context(cwd);
    const result = await editTransactionTool.execute({ edits: [
      { path: "a.txt", find: "alpha", replace: "one", replaceAll: false },
      { path: "b.txt", find: "beta", replace: "two", replaceAll: true }
    ] }, ctx);

    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("one\n");
    expect(await fs.readFile(path.join(cwd, "b.txt"), "utf8")).toBe("two two\n");
    expect(ctx.mutationLog).toEqual(["a.txt", "b.txt"]);
    expect(result.details).toMatchObject({ transactional: true, paths: ["a.txt", "b.txt"] });
    expect(result.content[0]?.text).toContain("- alpha");
  });

  it("commits multiple non-overlapping replacements in one file against its original content", async () => {
    const cwd = await workspace();
    await fs.writeFile(path.join(cwd, "a.txt"), "alpha beta gamma\n");
    const ctx = context(cwd);

    const result = await editTransactionTool.execute({ edits: [
      { path: "a.txt", find: "alpha", replace: "beta", replaceAll: false },
      { path: "a.txt", find: "beta", replace: "two", replaceAll: false },
      { path: "a.txt", find: "gamma", replace: "three", replaceAll: false }
    ] }, ctx);

    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("beta two three\n");
    expect(ctx.mutationLog).toEqual(["a.txt"]);
    expect(result.details).toMatchObject({ transactional: true, paths: ["a.txt"] });
    expect(result.details?.preview).toHaveLength(3);
  });

  it("changes nothing when replacement groups overlap", async () => {
    const cwd = await workspace();
    await fs.writeFile(path.join(cwd, "a.txt"), "alpha beta\n");
    const ctx = context(cwd);

    await expect(editTransactionTool.execute({ edits: [
      { path: "a.txt", find: "alpha beta", replace: "one", replaceAll: false },
      { path: "a.txt", find: "beta", replace: "two", replaceAll: false }
    ] }, ctx)).rejects.toThrow("Overlapping replacements in a.txt; no files were changed");
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("alpha beta\n");
    expect(ctx.mutationLog).toEqual([]);
  });

  it("changes nothing when any target fails validation", async () => {
    const cwd = await workspace();
    await fs.writeFile(path.join(cwd, "a.txt"), "alpha\n");
    await fs.writeFile(path.join(cwd, "b.txt"), "beta\n");
    const ctx = context(cwd);

    await expect(editTransactionTool.execute({ edits: [
      { path: "a.txt", find: "alpha", replace: "changed", replaceAll: false },
      { path: "b.txt", find: "missing", replace: "changed", replaceAll: false }
    ] }, ctx)).rejects.toThrow("no files were changed");
    expect(await fs.readFile(path.join(cwd, "a.txt"), "utf8")).toBe("alpha\n");
    expect(await fs.readFile(path.join(cwd, "b.txt"), "utf8")).toBe("beta\n");
    expect(ctx.mutationLog).toEqual([]);
  });
});
