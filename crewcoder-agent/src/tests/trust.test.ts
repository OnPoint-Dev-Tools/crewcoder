import { describe, expect, it } from "vitest";
import type { CrewCoderConfig } from "../core/config.js";
import { getTrustTier, isExtensionTrusted, isTrustTier, getExtensionCapabilities } from "../core/trust.js";

function config(overrides: Partial<CrewCoderConfig> = {}): CrewCoderConfig {
  return {
    integrationProfile: "standalone",
    defaultMode: "general",
    defaultProvider: "codex",
    defaultModel: undefined,
    thinkingEnabled: true,
    maxIterations: 0,
    stallDetection: true,
    stallRepeatThreshold: 3,
    stallErrorThreshold: 8,
    allowExtensionTools: false,
    allowExtensionHooks: false,
    allowExtensionModules: false,
    allowExtensionLiveUi: false,
    disabledExtensions: [],
    trustedExtensions: [],
    sandboxedExtensions: [],
    extensionRegistries: [],
    useDefaultExtensionRegistry: true,
    sandboxAllowedHosts: [],
    sandboxNetworkIsolation: "proxy",
    activeWorker: "Crew",
    checkpointsEnabled: true,
    autoCompact: false,
    autoCompactThresholdTokens: 150000,
    compactionPreview: false,
    autoActivateExtensionSkills: true,
    modelPricing: {},
    ...overrides,
    goals: overrides.goals ?? { maxTurns: 200, timeoutMinutes: 480 }
  };
}

describe("extension trust tiers", () => {
  it("validates tier names", () => {
    expect(isTrustTier("trusted")).toBe(true);
    expect(isTrustTier("sandboxed")).toBe(true);
    expect(isTrustTier("prompt-only")).toBe(true);
    expect(isTrustTier("full-access")).toBe(false);
  });

  it("resolves tiers from the two id lists, defaulting to prompt-only", () => {
    const c = config({ trustedExtensions: ["a"], sandboxedExtensions: ["b"] });
    expect(getTrustTier(c, "a")).toBe("trusted");
    expect(getTrustTier(c, "b")).toBe("sandboxed");
    expect(getTrustTier(c, "c")).toBe("prompt-only");
    expect(isExtensionTrusted(c, "a")).toBe(true);
    expect(isExtensionTrusted(c, "b")).toBe(false);
  });

  it("maps tiers to capabilities", () => {
    const c = config({ trustedExtensions: ["a"], sandboxedExtensions: ["b"] });
    expect(getExtensionCapabilities(c, "a")).toEqual({ tier: "trusted", tools: true, toolsSandboxed: false, fullAccess: true });
    expect(getExtensionCapabilities(c, "b")).toEqual({ tier: "sandboxed", tools: true, toolsSandboxed: true, fullAccess: false });
    expect(getExtensionCapabilities(c, "c")).toEqual({ tier: "prompt-only", tools: false, toolsSandboxed: false, fullAccess: false });
  });
});
