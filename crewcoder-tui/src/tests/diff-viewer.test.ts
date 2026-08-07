import { describe, expect, it } from "vitest";
import { MainViewport } from "../components/MainViewport.js";
import { createInitialState } from "../state/tui-store.js";
import { bg, stripAnsi } from "../tui/ansi.js";
import { crewCoderTheme } from "../theme/theme.js";

describe("TUI diff viewer", () => {
  it("renders edit tool calls side by side with line numbers", () => {
    const state = createInitialState();
    state.blocks = [{ type: "tool", name: "edit", status: "done", args: { path: "src/app.ts", find: "const old = 1;\nreturn old;", replace: "const next = 2;\nreturn next;" } }];
    const rendered = new MainViewport(state).render({ theme: crewCoderTheme, size: { width: 90, height: 12 } });
    const plain = rendered.map(stripAnsi).join("\n");
    expect(plain).toContain("BEFORE");
    expect(plain).toContain("AFTER");
    expect(plain).toContain("1 -const old = 1;");
    expect(plain).toContain("1 +const next = 2;");
    expect(plain).toContain("n/p jump hunks");
    expect(rendered.join("\n")).toContain(bg(crewCoderTheme.diffDelBg));
    expect(rendered.join("\n")).toContain(bg(crewCoderTheme.diffAddBg));
  });

  it("parses unified metadata diffs and jumps between hunks", () => {
    const state = createInitialState();
    state.blocks = [{ type: "tool", name: "bash", status: "done", args: { command: "apply patch" }, metadata: { diff: "@@ -2,1 +2,1 @@ first\n-old\n+new\n@@ -20,1 +20,1 @@ second\n-before\n+after" } }];
    const viewport = new MainViewport(state);
    const context = { theme: crewCoderTheme, size: { width: 84, height: 8 } };
    const plain = viewport.render(context).map(stripAnsi).join("\n");
    expect(plain).toContain("@@ -2 +2 @@ first");
    expect(plain).toContain("@@ -20 +20 @@ second");
    expect(viewport.jumpDiffHunk("next")).toBe(true);
    const first = state.viewportScroll;
    expect(viewport.jumpDiffHunk("next")).toBe(true);
    expect(state.viewportScroll).not.toBe(first);
    expect(viewport.jumpDiffHunk("previous")).toBe(true);
    expect(state.viewportScroll).toBe(first);
  });
});
