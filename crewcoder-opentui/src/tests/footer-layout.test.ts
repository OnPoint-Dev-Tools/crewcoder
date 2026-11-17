import type { TuiEventBlock } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import { describe, expect, it } from "vitest";
import { toolApprovalHeight } from "../components/ui/tool-approval.js";
import { COMPOSER_ROWS, composerRows, MAX_COMPOSER_LINES, wrappedLineCount, footerModel, footerHeight, HOME_BODY_ROWS, homeComposerWidth, homeLogo, isHome, shortenPath, MAX_FOOTER_TOOLS, RESERVED_ROWS, STATUS_ROWS, streamingTail } from "../footer-layout.js";

const tool = (id: string): TuiEventBlock => ({ type: "tool", id, name: "bash", status: "running" });

describe("footerModel", () => {
  it("keeps the reserved tail and working rows so idle and running heights match", () => {
    expect(footerModel([], false).rows).toBe(RESERVED_ROWS + COMPOSER_ROWS + STATUS_ROWS);
    expect(footerModel([], true).rows).toBe(footerModel([], false).rows);
    expect(footerModel([{ type: "assistant", text: "hi" }], true).rows).toBe(footerModel([], false).rows);
  });

  it("adds a working row, the streaming tail, and bounded running tools", () => {
    const pending = [tool("1"), tool("2"), tool("3"), tool("4"), tool("5"), { type: "assistant", text: "hi" } satisfies TuiEventBlock];
    const model = footerModel(pending, true);

    expect(model.tools).toHaveLength(MAX_FOOTER_TOOLS);
    expect(model.hiddenTools).toBe(2);
    expect(model.streaming?.type).toBe("assistant");
    expect(model.rows).toBe(MAX_FOOTER_TOOLS + 1 + RESERVED_ROWS + COMPOSER_ROWS + STATUS_ROWS);
  });

  it("sizes a pending approval card from its content", () => {
    const approval: TuiEventBlock = { type: "approval", id: "a", toolName: "bash", text: "rm build", args: { command: "rm -r build" }, status: "pending" };
    const model = footerModel([approval], true);

    expect(model.approval).toBe(approval);
    expect(model.rows).toBe(toolApprovalHeight({ description: "rm build", args: { command: "rm -r build" } }) + RESERVED_ROWS + COMPOSER_ROWS + STATUS_ROWS);
  });

  it("does not treat a finished-run assistant block as streaming", () => {
    expect(footerModel([{ type: "assistant", text: "x" }], false).streaming).toBeUndefined();
  });
});

describe("toolApprovalHeight", () => {
  it("bounds the argument list", () => {
    const args = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    expect(toolApprovalHeight({ args })).toBe(2 + 1 + 1 + (1 + 3 + 1) + 1);
    expect(toolApprovalHeight({})).toBe(5);
  });
});

describe("streamingTail", () => {
  it("shows the end of the last line, truncated from the left", () => {
    expect(streamingTail("first\nsecond line", 40)).toBe("second line");
    expect(streamingTail("abcdefghij", 6)).toBe("…ghij");
  });
});

describe("home screen layout", () => {
  it("shows only for an empty, idle session", () => {
    expect(isHome([], false)).toBe(true);
    expect(isHome([], true)).toBe(false);
    expect(isHome([{ type: "error", text: "/goal is not available" }], false)).toBe(false);
  });

  it("shows the big wordmark only when it fits, otherwise no logo at all", () => {
    const logo = ["x".repeat(60), "x".repeat(60)];
    expect(homeLogo(80, 30, logo)).toBe(logo);
    expect(homeLogo(69, 30, logo)).toBeUndefined();
    expect(homeLogo(61, 30, ["x".repeat(66)])).toBeUndefined();
    // Too short to keep the composer whole under the logo.
    expect(homeLogo(80, 2 + HOME_BODY_ROWS + 1, logo)).toBeUndefined();
    expect(homeLogo(80, 2 + HOME_BODY_ROWS + 2, logo)).toBe(logo);
  });

  it("sizes the composer at 62% with a floor", () => {
    expect(homeComposerWidth(100)).toBe(62);
    expect(homeComposerWidth(30)).toBe(24);
    expect(homeComposerWidth(20)).toBe(20);
  });
});

describe("shortenPath", () => {
  it("abbreviates the local home and keeps the end of long paths", () => {
    expect(shortenPath("/home/me/code/app", 40, "/home/me")).toBe("~/code/app");
    expect(shortenPath("/home/meadow/x", 40, "/home/me")).toBe("/home/meadow/x");
    expect(shortenPath("/srv/projects/crewcoder", 12)).toBe("…s/crewcoder");
    expect(shortenPath("/srv/projects/crewcoder", 12)).toHaveLength(12);
  });
});

describe("footerHeight", () => {
  it("fills the terminal on the welcome screen", () => {
    expect(footerHeight({ home: true, contentRows: 6, terminalHeight: 30 })).toBe(30);
    expect(footerHeight({ home: true, contentRows: 40, terminalHeight: 30 })).toBe(40);
  });

  it("is just its content in a conversation", () => {
    expect(footerHeight({ home: false, contentRows: 6, terminalHeight: 30 })).toBe(6);
  });
});

describe("composer sizing", () => {
  it("counts word-wrapped lines like the textarea", () => {
    expect(wrappedLineCount("", 10)).toBe(1);
    expect(wrappedLineCount("a\nb\n", 10)).toBe(3);
    expect(wrappedLineCount("hello world", 11)).toBe(1);
    expect(wrappedLineCount("hello world", 8)).toBe(2);
    expect(wrappedLineCount("x".repeat(25), 10)).toBe(3);
  });

  it("grows the footer with the composer up to the cap", () => {
    expect(composerRows(1)).toBe(COMPOSER_ROWS);
    expect(composerRows(100)).toBe(MAX_COMPOSER_LINES + 2);
    expect(footerModel([], false, { composerRows: composerRows(3), alertRows: 4 }).rows).toBe(footerModel([], false).rows + 2 + 4);
    expect(footerModel([], false, { overlayRows: 9, alertRows: 4 }).rows).toBe(9);
  });
});
