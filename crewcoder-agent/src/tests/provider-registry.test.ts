import { afterEach, describe, expect, it, vi } from "vitest";
import { listProviders } from "../providers/provider-registry.js";
import { builtinProviders } from "../providers/builtins.js";

describe("provider registry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("includes built-in providers", async () => {
    const providers = await listProviders();
    expect(providers.map(p => p.id)).toEqual(expect.arrayContaining(["codex", "opencode", "opencode-go"]));
  });

  it("uses the OpenCode Go Kimi code model id", () => {
    const provider = builtinProviders.find((item) => item.id === "opencode-go");

    expect(provider?.models).toContain("kimi-k2.7-code");
    expect(provider?.models).not.toContain("kimi-k2.7");
  });

  it("hydrates OpenCode models from the provider models endpoint when auth is available", async () => {
    vi.stubEnv("OPENCODE_API_KEY", "test-key");
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
      expect(String(url)).toMatch(/\/models$/);
      return new Response(JSON.stringify({ data: [{ id: "live-a" }, { id: "live-b" }] }), { status: 200 });
    }));

    const providers = await listProviders();
    const opencode = providers.find((provider) => provider.id === "opencode");

    expect(opencode?.models).toEqual(["live-a", "live-b"]);
    expect(opencode?.defaultModel).toBe("live-a");
  });

  it("hydrates official OpenAI models from its derived models endpoint", async () => {
    vi.stubEnv("OPENAI_API_KEY", "openai-key");
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://api.openai.com/v1/models");
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer openai-key");
      return new Response(JSON.stringify({ data: [{ id: "gpt-live" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const providers = await listProviders();

    expect(providers.find((provider) => provider.id === "openai")?.models).toEqual(["gpt-live"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps static OpenCode models when auth is unavailable", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const providers = await listProviders();
    const opencode = providers.find((provider) => provider.id === "opencode");
    const fallback = builtinProviders.find((provider) => provider.id === "opencode");

    expect(fetch).not.toHaveBeenCalled();
    expect(opencode?.models).toEqual(fallback?.models);
  });
});
