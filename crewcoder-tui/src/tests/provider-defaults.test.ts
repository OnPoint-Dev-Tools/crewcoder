import { describe, expect, it } from "vitest";
import { builtinProviderDefaults, resolveProviderRecord } from "../components/App.js";

describe("provider defaults", () => {
  it("uses fallback provider defaults only when discovery is empty", () => {
    const provider = resolveProviderRecord("codex");
    const fallback = builtinProviderDefaults.find((item) => item.id === "codex");

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
