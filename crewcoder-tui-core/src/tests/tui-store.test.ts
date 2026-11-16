import { describe, expect, it } from "vitest";
import { isTuiMode, normalizeTuiMode, TUI_MODES } from "../state/tui-store.js";

describe("TUI modes", () => {
  it("accepts the deliberate CrewCoder mode", () => {
    expect(TUI_MODES).toEqual(["general", "crewcoder", "plugin", "extension"]);
    expect(isTuiMode("crewcoder")).toBe(true);
    expect(normalizeTuiMode(" CrewCoder ")).toBe("crewcoder");
  });

  it("keeps legacy auto and unknown values on the general default", () => {
    expect(isTuiMode("auto")).toBe(false);
    expect(normalizeTuiMode("auto")).toBe("general");
    expect(normalizeTuiMode("unknown")).toBe("general");
  });
});
