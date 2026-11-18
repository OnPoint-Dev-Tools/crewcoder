import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ScrollbackWriter } from "../scrollback-writer.js";
import { slateTheme } from "../theme.js";

let active: TestRendererSetup | undefined;

afterEach(async () => {
  await active?.dispose();
  active = undefined;
});

async function setup(width = 40): Promise<{ term: TestRendererSetup; writer: ScrollbackWriter; flush: () => Promise<string[]> }> {
  const term = await createTestRenderer({ width, height: 20, screenMode: "split-footer", externalOutputMode: "capture-stdout", footerHeight: 4 });
  active = term;
  const writer = new ScrollbackWriter(term.renderer, slateTheme);
  const flush = async (): Promise<string[]> => {
    await term.renderOnce();
    return term.externalOutput.take().flatMap((commit) => commit.rows.map((row) => row.trimEnd()));
  };
  return { term, writer, flush };
}

describe("ScrollbackWriter", () => {
  it("commits settled blocks once, in order, separated by a blank row", async () => {
    const { writer, flush } = await setup();
    const blocks: TuiEventBlock[] = [
      { type: "user", text: "fix it", background: ["repo: crewcoder"] },
      { type: "assistant", text: "done" }
    ];

    expect(writer.sync(blocks, false)).toEqual([]);
    expect(await flush()).toEqual(["YOU", "fix it", "repo: crewcoder", "", "CREW CODER", "done"]);

    writer.sync(blocks, false);
    expect(await flush()).toEqual([]);
  });

  it("streams finished rows of the last assistant block and holds back the changing row", async () => {
    const { writer, flush } = await setup(20);
    const reply: TuiEventBlock = { type: "assistant", text: "one two three four five six" };
    const blocks: TuiEventBlock[] = [reply];

    expect(writer.sync(blocks, true)).toEqual([reply]);
    const first = await flush();
    expect(first[0]).toBe("CREW CODER");
    expect(first.join(" ")).not.toContain("six");

    reply.text += " seven eight";
    writer.sync(blocks, true);
    writer.sync(blocks, false);
    const rest = await flush();
    const all = [...first, ...rest];

    expect(all.slice(1).join(" ").replace(/\s+/g, " ")).toBe("one two three four five six seven eight");
    expect(writer.pending).toEqual([]);
  });

  it("holds every block after a live one so scrollback stays in order", async () => {
    const { writer, flush } = await setup();
    const tool: TuiEventBlock = { type: "tool", id: "t1", name: "bash", status: "running" };
    const after: TuiEventBlock = { type: "assistant", text: "after the tool" };
    const blocks: TuiEventBlock[] = [{ type: "user", text: "go" }, tool, after];

    expect(writer.sync(blocks, true)).toEqual([tool, after]);
    expect(await flush()).toEqual(["YOU", "go"]);

    tool.status = "done";
    tool.text = "ok";
    expect(writer.sync(blocks, true)).toEqual([after]);
    writer.sync(blocks, false);
    expect(await flush()).toEqual(["", "💻 Run Command", "   ok", "", "CREW CODER", "after the tool"]);
  });

  it("does not re-commit blocks after the reducer trims and re-slices the array", async () => {
    const { writer, flush } = await setup();
    const blocks: TuiEventBlock[] = [{ type: "system", text: "a" }, { type: "system", text: "b" }];
    writer.sync(blocks, false);
    await flush();

    const trimmed = [...blocks.slice(-1), { type: "system", text: "c" } satisfies TuiEventBlock];
    writer.sync(trimmed, false);

    expect(await flush()).toEqual(["", "SYSTEM", "c"]);
  });

  it("starts at the top on wide screens and pins a fresh narrow screen to the bottom", async () => {
    const { term, flush } = await setup();
    const writer = new ScrollbackWriter(term.renderer, slateTheme, () => term.renderer.terminalWidth < 70 ? 3 : 0);
    writer.sync([{ type: "user", text: "one" }, { type: "assistant", text: "two" }], false);
    expect(await flush()).toEqual(["", "", "", "YOU", "one", "", "CREW CODER", "two"]);

    writer.sync([], false);
    writer.sync([{ type: "user", text: "fresh" }], false);
    expect((await flush()).filter(Boolean)).toEqual(["YOU", "fresh"]);
  });

  it("orders a turn as sections: reasoning, then the work as one stacked section, then the reply", async () => {
    const term = await createTestRenderer({ width: 40, height: 20, screenMode: "split-footer", externalOutputMode: "capture-stdout", footerHeight: 4 });
    active = term;
    const writer = new ScrollbackWriter(term.renderer, slateTheme, () => 0, () => "/repo");
    writer.sync([
      { type: "thinking", text: "look first" },
      { type: "tool", name: "Read", status: "done", args: { file_path: "/repo/src/App.jsx" }, text: "contents" },
      { type: "tool", name: "Edit", status: "done", args: { file_path: "/repo/src/App.jsx" } },
      { type: "assistant", text: "Updated the app." }
    ], false);
    await term.renderOnce();
    const rows = term.externalOutput.take().flatMap((commit) => commit.rows.map((row) => row.trimEnd()));

    expect(rows.slice(rows.indexOf("└──────────────────────────────────────┘"))).toEqual([
      "└──────────────────────────────────────┘",
      "",
      "📖 Read File",
      "   src/App.jsx",
      "± Edit File: src/App.jsx",
      "",
      "CREW CODER",
      "Updated the app."
    ]);
    expect(rows[1]).toMatch(/💭 Reasoning/);
  });

  it("draws reasoning as a bordered Reasoning panel", async () => {
    const { writer, flush } = await setup(30);
    writer.sync([{ type: "thinking", text: "check the tests first\n\n" }], false);
    const rows = await flush();

    expect(rows[0]).toMatch(/^┌─+┐$/);
    expect(rows[1]).toMatch(/^│ 💭 Reasoning\s+│$/);
    expect(rows[2]).toMatch(/^│\s+│$/);
    expect(rows[3]).toMatch(/^│ check the tests first\s+│$/);
    // Trailing blank lines are trimmed, so the panel closes right after the text.
    expect(rows[4]).toMatch(/^└─+┘$/);
    expect(rows).toHaveLength(5);
  });

  it("streams reasoning but holds back its last text row and bottom border", async () => {
    const { writer, flush } = await setup(24);
    const thinking: TuiEventBlock = { type: "thinking", text: "alpha beta gamma delta epsilon zeta" };
    writer.sync([thinking], true);
    const first = await flush();
    expect(first.at(-1)).not.toMatch(/^└/);
    expect(first.join(" ")).not.toContain("zeta");

    thinking.text += " eta";
    writer.sync([thinking], false);
    const all = [...first, ...(await flush())];
    const text = all.slice(3, -1).map((row) => row.replace(/^│\s?|\s*│$/g, "")).join(" ").replace(/\s+/g, " ").trim();
    expect(text).toBe("alpha beta gamma delta epsilon zeta eta");
    expect(all.at(-1)).toMatch(/^└─+┘$/);
    expect(all.filter((row) => row.includes("Reasoning"))).toHaveLength(1);
  });

  it("renders assistant replies as markdown", async () => {
    const { writer, flush } = await setup(40);
    const text = "## Plan\n\nUse **bold** and `code`.\n\n- first\n- second\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    writer.sync([{ type: "assistant", text }], false);
    const rows = await flush();

    expect(rows[0]).toBe("CREW CODER");
    expect(rows).toContain("Plan");
    expect(rows).toContain("Use bold and code.");
    expect(rows.some((row) => /^\s*[-•]\s+first$/.test(row))).toBe(true);
    expect(rows).toContain("│ const x = 1;");
    expect(rows.some((row) => row.includes("1") && row.includes("2") && row.includes("│"))).toBe(true);
    expect(rows.join("\n")).not.toMatch(/\*\*|```|##/);
  });

  it("commits the same rows whether a markdown reply streams in or arrives whole", async () => {
    const text = [
      "# Cache setup",
      "",
      "The build cache is configured for local and CI runs, with remote credentials read from the environment so nothing secret lands in the repository.",
      "",
      "1. Add the cache step",
      "2. Point it at the bucket",
      "",
      "```sh",
      "npm run build -- --cache remote",
      "npm test",
      "```",
      "",
      "| runner | hit rate |",
      "|---|---|",
      "| local | 80% |",
      "| ci | 95% |",
      "",
      "> Note: cold caches are slower on the first run.",
      "",
      "Done."
    ].join("\n");

    const whole = await setup(36);
    whole.writer.sync([{ type: "assistant", text }], false);
    const expected = await whole.flush();
    await whole.term.dispose();
    active = undefined;

    const streamed = await setup(36);
    const reply: TuiEventBlock = { type: "assistant", text: "" };
    const rows: string[] = [];
    for (let at = 0; at < text.length;) {
      const size = 1 + ((at * 7) % 13);
      reply.text = text.slice(0, at + size);
      at += size;
      streamed.writer.sync([reply], true);
      rows.push(...(await streamed.flush()));
    }
    // Final blocks and finished paragraph rows stream out early; only the open tail waits for the end.
    const streamedEarly = rows.length;
    streamed.writer.sync([reply], false);
    rows.push(...(await streamed.flush()));

    expect(rows).toEqual(expected);
    expect(streamedEarly).toBeGreaterThan(expected.length - 3);
  });

  it("drops a streaming block that disappears, such as after /new", async () => {
    const { writer, flush } = await setup();
    writer.sync([{ type: "assistant", text: "partial" }], true);
    await flush();

    expect(writer.sync([], false)).toEqual([]);
    writer.sync([{ type: "user", text: "fresh" }], false);
    expect((await flush()).filter(Boolean)).toEqual(["YOU", "fresh"]);
  });
});
