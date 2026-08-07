import { describe, expect, it } from "vitest";
import { AGENT_MODES, DEFAULT_AGENT_MODE, isAgentMode, normalizeAgentMode, resolveMode } from "../core/mode-router.js";

describe("mode router", () => {
  it("defaults to general", () => {
    expect(DEFAULT_AGENT_MODE).toBe("general");
  });

  it("exposes exactly the explicit modes and rejects auto", () => {
    expect([...AGENT_MODES]).toEqual(["general", "plugin", "extension"]);
    expect(isAgentMode("auto")).toBe(false);
  });

  it("resolves each mode to itself", () => {
    expect(resolveMode("general")).toBe("general");
    expect(resolveMode("plugin")).toBe("plugin");
    expect(resolveMode("extension")).toBe("extension");
  });

  it("coerces the legacy persisted auto mode to general", () => {
    expect(normalizeAgentMode("auto")).toBe("general");
    expect(normalizeAgentMode("AUTO")).toBe("general");
  });

  it("coerces unknown or missing values to the default", () => {
    expect(normalizeAgentMode("nonsense")).toBe("general");
    expect(normalizeAgentMode(undefined)).toBe("general");
    expect(normalizeAgentMode(42)).toBe("general");
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(normalizeAgentMode("  Extension ")).toBe("extension");
  });
});
