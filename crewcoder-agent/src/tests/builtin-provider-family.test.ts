import { describe, expect, it } from "vitest";
import { builtinProviders } from "../providers/builtins.js";
import { resolveProviderTransport } from "../providers/provider-transport.js";

describe("built-in provider family", () => {
  it("registers first-party and OpenAI-compatible providers with explicit credentials", () => {
    const expected = new Map([
      ["openai", "OPENAI_API_KEY"],
      ["anthropic", "ANTHROPIC_API_KEY"],
      ["openrouter", "OPENROUTER_API_KEY"],
      ["xai", "XAI_API_KEY"],
      ["deepseek", "DEEPSEEK_API_KEY"],
      ["mistral", "MISTRAL_API_KEY"]
    ]);

    for (const [id, apiKeyEnv] of expected) {
      const provider = builtinProviders.find((candidate) => candidate.id === id);
      expect(provider, `missing ${id}`).toBeDefined();
      expect(provider?.apiKeyEnv).toBe(apiKeyEnv);
      expect(provider?.endpoint).toMatch(/^https:\/\//);
      expect(provider?.defaultModel).toBeTruthy();
    }
  });

  it("uses HTTP streaming unless a provider has an implemented native agent protocol", () => {
    for (const id of ["openai", "anthropic", "openrouter", "xai", "deepseek", "mistral"]) {
      const provider = builtinProviders.find((candidate) => candidate.id === id)!;
      expect(resolveProviderTransport(provider)).toEqual({
        channel: "http-sse",
        continuation: "none",
        replay: "pre-stream-only"
      });
    }
    expect(resolveProviderTransport(builtinProviders.find((provider) => provider.id === "claude")!)).toEqual({
      channel: "process",
      continuation: "provider-session",
      replay: "never"
    });
    expect(resolveProviderTransport(builtinProviders.find((provider) => provider.id === "codex")!)).toMatchObject({
      channel: "process",
      continuation: "provider-session",
      fallback: "http-sse"
    });
  });

  it("keeps official Anthropic authentication provider-specific", () => {
    const anthropic = builtinProviders.find((provider) => provider.id === "anthropic");
    expect(anthropic?.runtime).toBe("anthropic-messages");
    expect(anthropic?.authScheme).toBe("anthropic-key");
  });
});
