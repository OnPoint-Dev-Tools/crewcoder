import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { ScrollbackWriter } from "../scrollback-writer.js";
import { gothamTheme } from "../theme.js";

let active: TestRendererSetup | undefined;

afterEach(async () => {
  await active?.dispose();
  active = undefined;
});

async function setup(width = 40): Promise<{ term: TestRendererSetup; writer: ScrollbackWriter; flush: () => Promise<string[]> }> {
  const term = await createTestRenderer({ width, height: 20, screenMode: "split-footer", externalOutputMode: "capture-stdout", footerHeight: 4 });
  active = term;
  const writer = new ScrollbackWriter(term.renderer, gothamTheme);
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
    expect(await flush()).toEqual(["", "TOOL bash · done", "ok", "", "CREW CODER", "after the tool"]);
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

  it("pads a fresh screen once so the footer starts at the bottom, and again after /new", async () => {
    const { term, flush } = await setup();
    const writer = new ScrollbackWriter(term.renderer, gothamTheme, () => 3);
    writer.sync([{ type: "user", text: "one" }, { type: "assistant", text: "two" }], false);
    expect(await flush()).toEqual(["", "", "", "YOU", "one", "", "CREW CODER", "two"]);

    writer.sync([], false);
    writer.sync([{ type: "user", text: "fresh" }], false);
    expect(await flush()).toEqual(["", "", "", "YOU", "fresh"]);
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
