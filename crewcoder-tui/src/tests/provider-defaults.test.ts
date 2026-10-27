import { afterEach, describe, expect, it, vi } from "vitest";
import { builtinProviderDefaults, resolveProviderRecord } from "../components/App.js";
import { createInitialState } from "../state/tui-store.js";
import { effortLevelsForModel } from "../state/effort-levels.js";

afterEach(() => vi.unstubAllEnvs());

describe("provider defaults", () => {
  it("uses codex-cli as the sole Codex fallback with GPT-6 effort controls", () => {
    vi.stubEnv("CREWCODER_PROVIDER", undefined);
    expect(createInitialState().provider).toBe("codex-cli");
    expect(builtinProviderDefaults.map((provider) => provider.id)).not.toContain("codex");
    expect(effortLevelsForModel("codex-cli", "gpt-6-sol")).toContain("xhigh");
  });
  it("uses fallback provider defaults only when discovery is empty", () => {
    const provider = resolveProviderRecord("codex-cli");
    const fallback = builtinProviderDefaults.find((item) => item.id === "codex-cli");

    expect(provider.models).toEqual(fallback?.models);
    expect(provider.models.length).toBeGreaterThan(1);
  });

  it("trusts discovered provider models instead of overriding them with defaults", () => {
    const provider = resolveProviderRecord("opencode", {
      id: "opencode",
      title: "OpenCode Zen",
      models: ["live-model"],
      defaultModel: "live-model"
    });

    expect(provider.models).toEqual(["live-model"]);
  });
});
