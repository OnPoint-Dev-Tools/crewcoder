import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { currentMention, listPathSuggestions, MENTION_ROWS, mentionRows, mentionWindowStart, replaceMention } from "../path-suggestions.js";

describe("currentMention", () => {
  it("finds the @token around the cursor", () => {
    expect(currentMention("look at @src/ap", 15)).toEqual({ start: 8, end: 15, query: "src/ap" });
    expect(currentMention("@", 1)).toEqual({ start: 0, end: 1, query: "" });
    // Cursor inside the token: the token runs to the next whitespace.
    expect(currentMention("see @src/app.ts now", 8)).toEqual({ start: 4, end: 15, query: "src/app.ts" });
    expect(currentMention("line one\n@do", 12)).toEqual({ start: 9, end: 12, query: "do" });
  });

  it("ignores emails, finished tokens, and non-path characters", () => {
    expect(currentMention("mail user@host", 14)).toBeUndefined();
    expect(currentMention("@src/app.ts ", 12)).toBeUndefined();
    expect(currentMention("@what?", 6)).toBeUndefined();
    expect(currentMention("plain text", 10)).toBeUndefined();
  });
});

describe("replaceMention", () => {
  it("finishes a file with a space and keeps a directory open", () => {
    const token = { start: 8, end: 11, query: "sr" };
    expect(replaceMention("look at @sr please", token, { path: "src/app.ts", type: "file" })).toEqual({ text: "look at @src/app.ts  please", cursor: 20 });
    expect(replaceMention("look at @sr", token, { path: "src/", type: "directory" })).toEqual({ text: "look at @src/", cursor: 13 });
  });
});

describe("mention list window", () => {
  it("keeps the highlighted row visible and sizes the list", () => {
    expect(mentionWindowStart(5, 4)).toBe(0);
    expect(mentionWindowStart(20, MENTION_ROWS - 1)).toBe(0);
    expect(mentionWindowStart(20, MENTION_ROWS)).toBe(1);
    expect(mentionWindowStart(20, 19)).toBe(20 - MENTION_ROWS);
    expect(mentionRows(0)).toBe(1);
    expect(mentionRows(3)).toBe(3);
    expect(mentionRows(40)).toBe(MENTION_ROWS);
  });
});

describe("listPathSuggestions", () => {
  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), "mentions-"));
    for (const dir of ["src/components", "node_modules/pkg", ".git", "docs"]) mkdirSync(join(root, dir), { recursive: true });
    for (const file of ["src/app.ts", "src/components/Button.tsx", "node_modules/pkg/index.js", ".git/HEAD", "docs/guide.md", "README.md"]) writeFileSync(join(root, file), "");
    return root;
  }

  it("lists directories first, skips ignored folders, and uses POSIX relative paths", async () => {
    const paths = (await listPathSuggestions(workspace(), "", 50)).map((entry) => entry.path);
    expect(paths).toEqual(["docs/", "docs/guide.md", "src/", "src/components/", "src/components/Button.tsx", "src/app.ts", "README.md"]);
  });

  it("matches a path prefix, a segment, or a file name, case-insensitively", async () => {
    const root = workspace();
    expect((await listPathSuggestions(root, "src/a", 50)).map((entry) => entry.path)).toEqual(["src/app.ts"]);
    expect((await listPathSuggestions(root, "button", 50)).map((entry) => entry.path)).toEqual(["src/components/Button.tsx"]);
    expect((await listPathSuggestions(root, "./docs", 50)).map((entry) => entry.path)).toEqual(["docs/", "docs/guide.md"]);
    expect(await listPathSuggestions(root, "src", 2)).toHaveLength(2);
  });

  it("returns nothing for an unreadable workspace", async () => {
    expect(await listPathSuggestions(join(tmpdir(), "does-not-exist-crewcoder"), "", 50)).toEqual([]);
  });
});
