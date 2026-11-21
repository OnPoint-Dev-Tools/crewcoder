import { describe, expect, it } from "vitest";
import { toolApprovalHeight } from "../components/ui/tool-approval.js";
import { COMPOSER_ROWS, composerRows, MAX_COMPOSER_LINES, wrappedLineCount, HOME_BODY_ROWS, homeComposerWidth, homeLogo, isHome, shortenPath } from "../footer-layout.js";

describe("toolApprovalHeight", () => {
  it("bounds the argument list", () => {
    const args = { a: 1, b: 2, c: 3, d: 4, e: 5 };
    expect(toolApprovalHeight({ args })).toBe(2 + 1 + 1 + (1 + 3 + 1) + 1);
    expect(toolApprovalHeight({})).toBe(5);
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

describe("composer sizing", () => {
  it("counts word-wrapped lines like the textarea", () => {
    expect(wrappedLineCount("", 10)).toBe(1);
    expect(wrappedLineCount("a\nb\n", 10)).toBe(3);
    expect(wrappedLineCount("hello world", 11)).toBe(1);
    expect(wrappedLineCount("hello world", 8)).toBe(2);
    expect(wrappedLineCount("x".repeat(25), 10)).toBe(3);
  });

  it("grows the composer up to the cap", () => {
    expect(composerRows(1)).toBe(COMPOSER_ROWS);
    expect(composerRows(3)).toBe(COMPOSER_ROWS + 2);
    expect(composerRows(100)).toBe(MAX_COMPOSER_LINES + 2);
  });
});
