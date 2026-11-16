import { describe, expect, it } from "vitest";
import { applyFooterHeight, footerSettled, prepareFooterForWrites } from "../footer-sizer.js";
import { footerModel } from "../footer-layout.js";

const host = (footerHeight: number, height = footerHeight, terminalHeight = 30) => ({ footerHeight, height, terminalHeight });

describe("prepareFooterForWrites", () => {
  it("shrinks the full-height welcome footer as soon as the session has a block", () => {
    const h = host(30);
    prepareFooterForWrites(h, { blocks: [{ type: "user", text: "hi" }], running: true });
    expect(h.footerHeight).toBe(footerModel([], true).rows);
  });

  it("leaves the welcome screen and ordinary conversation footers alone", () => {
    const home = host(30);
    prepareFooterForWrites(home, { blocks: [], running: false });
    expect(home.footerHeight).toBe(30);

    // A stale pending list must not resize a conversation footer before writing.
    const chat = host(6);
    prepareFooterForWrites(chat, { blocks: [{ type: "assistant", text: "done" }], running: false });
    expect(chat.footerHeight).toBe(6);
  });
});

describe("applyFooterHeight", () => {
  it("sizes from the current pending blocks", () => {
    const h = host(30);
    applyFooterHeight(h, { blocks: [{ type: "user", text: "hi" }], running: false }, { pending: [] });
    expect(h.footerHeight).toBe(footerModel([], false).rows);
  });
});

describe("footerSettled", () => {
  it("is true only once the renderer applied the requested height", () => {
    expect(footerSettled(host(6, 30))).toBe(false);
    expect(footerSettled(host(6, 6))).toBe(true);
    expect(footerSettled(host(40, 30, 30))).toBe(true);
  });
});
