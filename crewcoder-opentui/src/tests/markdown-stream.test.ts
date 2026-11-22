import { MarkdownRenderable, SyntaxStyle } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { describe, expect, it } from "vitest";
import { codeFenceRenderer } from "../markdown-style.js";
import { slateTheme } from "../theme.js";

/**
 * Found by fuzzing: a list item holding a quote that becomes a table, plus a new
 * item, arriving in one delta. Crashed OpenTUI 0.9.2 in `updateList` (`ordinal`).
 */
const CRASHING_DELTAS = ["\n\n# h\n- > | a | b |\n", "|---|---|\n- # h"];

async function streamReply(deltas: readonly string[], withRail: boolean): Promise<string> {
  const { renderer, renderOnce, captureCharFrame } = await createTestRenderer({ width: 60, height: 20 });
  try {
    const syntaxStyle = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } }, renderer.nativeScene);
    const renderBlock = withRail ? codeFenceRenderer(renderer, slateTheme) : undefined;
    const md = new MarkdownRenderable(renderer, { content: "", syntaxStyle, streaming: true, conceal: true, width: "100%", renderBlock });
    renderer.root.add(md);
    let content = "";
    for (const delta of deltas) md.content = content += delta;
    md.streaming = false;
    await renderOnce();
    return captureCharFrame();
  } finally {
    renderer.destroy();
  }
}

describe("streamed reply markdown", () => {
  it("marks the code-fence renderer code-only so OpenTUI does not rebuild other blocks", async () => {
    const { renderer } = await createTestRenderer({ width: 10, height: 2 });
    try {
      expect(codeFenceRenderer(renderer, slateTheme).codeBlockOnly).toBe(true);
    } finally {
      renderer.destroy();
    }
  });

  it("streams nested lists, quotes, and tables without crashing", async () => {
    const frame = await streamReply(CRASHING_DELTAS, true);
    expect(frame).toContain("h");
  });

  it("still draws a rail around a fence without a language", async () => {
    const frame = await streamReply(["Run:\n\n```\nnpm", " test\n```\n"], true);
    expect(frame).toMatch(/│ ?npm test/);
  });
});
