import { describe, expect, it } from "vitest";
import { mouseEnabled, parseArgs } from "../args.js";
import { actionLabel, DEFAULT_APP_KEYBINDINGS, matchesAction } from "../keybindings.js";

const key = (name: string, modifiers: Partial<{ ctrl: boolean; meta: boolean; shift: boolean }> = {}) => ({ name, ctrl: false, meta: false, shift: false, ...modifiers });

describe("keybindings", () => {
  it("matches default chords exactly, including modifiers", () => {
    expect(matchesAction(key("y", { ctrl: true }), "approve")).toBe(true);
    expect(matchesAction(key("y"), "approve")).toBe(false);
    expect(matchesAction(key("y", { ctrl: true, shift: true }), "approve")).toBe(false);
    expect(matchesAction(key("escape"), "abort")).toBe(true);
  });

  it("honors overridden bindings", () => {
    const bindings = { ...DEFAULT_APP_KEYBINDINGS, approve: ["meta+a"] };
    expect(matchesAction(key("a", { meta: true }), "approve", bindings)).toBe(true);
    expect(matchesAction(key("y", { ctrl: true }), "approve", bindings)).toBe(false);
    expect(actionLabel("approve", bindings)).toBe("M-A");
  });

  it("labels default chords", () => {
    expect(actionLabel("approve")).toBe("^Y");
    expect(actionLabel("abort")).toBe("Esc");
    expect(actionLabel("questionSubmit")).toBe("Enter");
    expect(actionLabel("questionScrollUp")).toBe("PgUp");
  });
});

describe("parseArgs", () => {
  it("parses remote flags in both forms", () => {
    expect(parseArgs(["--remote", "me@vps", "--remote-cwd=/work"])).toEqual({ help: false, remote: "me@vps", remoteCwd: "/work" });
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("rejects unknown flags and missing values", () => {
    expect(() => parseArgs(["--theme", "dark"])).toThrow(/Unknown argument/);
    expect(() => parseArgs(["--remote"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--remote="])).toThrow(/requires a value/);
  });
});

describe("mouseEnabled", () => {
  it("is on unless CREWCODER_TUI_MOUSE is exactly 0, like the legacy UI", () => {
    expect(mouseEnabled({})).toBe(true);
    expect(mouseEnabled({ CREWCODER_TUI_MOUSE: "1" })).toBe(true);
    expect(mouseEnabled({ CREWCODER_TUI_MOUSE: "" })).toBe(true);
    expect(mouseEnabled({ CREWCODER_TUI_MOUSE: "0" })).toBe(false);
  });
});
