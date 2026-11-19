import { createTerminalCapabilities } from "@opentui/core/testing";
import { describe, expect, it } from "vitest";
import { reasoningIcon, resolveGlyphSet } from "../glyphs.js";

describe("resolveGlyphSet", () => {
  it("uses emoji when the terminal has Unicode width handling and no multiplexer (Ghostty)", () => {
    expect(resolveGlyphSet(createTerminalCapabilities({ unicode: "unicode-wide", multiplexer: "none" }), undefined)).toBe("emoji");
    expect(resolveGlyphSet(createTerminalCapabilities({ unicode: "unicode", multiplexer: "none" }), undefined)).toBe("emoji");
  });

  it("uses single-cell icons under a multiplexer, even when it reports Unicode widths (tmux)", () => {
    for (const multiplexer of ["tmux", "screen", "zellij", "unknown"] as const) {
      expect(resolveGlyphSet(createTerminalCapabilities({ unicode: "unicode", multiplexer }), undefined)).toBe("text");
    }
  });

  it("uses single-cell icons for plain wcwidth terminals and before the probe answers", () => {
    expect(resolveGlyphSet(createTerminalCapabilities({ unicode: "wcwidth", multiplexer: "none" }), undefined)).toBe("text");
    expect(resolveGlyphSet(null, undefined)).toBe("text");
    expect(resolveGlyphSet(undefined, undefined)).toBe("text");
  });

  it("honors the CREWCODER_TUI_ICONS override in both directions and ignores unknown values", () => {
    const tmux = createTerminalCapabilities({ unicode: "unicode", multiplexer: "tmux" });
    const ghostty = createTerminalCapabilities({ unicode: "unicode-wide", multiplexer: "none" });
    expect(resolveGlyphSet(tmux, "emoji")).toBe("emoji");
    expect(resolveGlyphSet(null, " Emoji ")).toBe("emoji");
    expect(resolveGlyphSet(ghostty, "text")).toBe("text");
    expect(resolveGlyphSet(ghostty, "auto")).toBe("emoji");
    expect(resolveGlyphSet(tmux, "sparkles")).toBe("text");
  });
});

describe("reasoningIcon", () => {
  it("is the emoji or a single-cell symbol", () => {
    expect(reasoningIcon("emoji")).toBe("💭");
    expect(reasoningIcon("text")).toBe("∴");
  });
});
