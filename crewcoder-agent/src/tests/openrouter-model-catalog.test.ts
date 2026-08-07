import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveOpenRouterContextWindow, resolveOpenRouterPricing } from "../providers/openrouter-model-catalog.js";

const temporaryHomes: string[] = [];

async function createHome(): Promise<string> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-openrouter-"));
  temporaryHomes.push(home);
  vi.stubEnv("CREWCODER_HOME", home);
  return home;
}

describe("OpenRouter model catalog", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(temporaryHomes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
  });

  it("resolves exact and unique suffix matches and persists usable pricing", async () => {
    const home = await createHome();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "openai/gpt-5.4-mini", context_length: 400_000, pricing: { prompt: "0.0000004", completion: "0.0000016", input_cache_read: "0.0000001", input_cache_write: "-1" } },
        { id: "moonshotai/kimi-k2.7-code", context_length: 262_144 }
      ]
    }), { status: 200 })));

    await expect(resolveOpenRouterContextWindow("gpt-5.4-mini")).resolves.toBe(400_000);
    await expect(resolveOpenRouterContextWindow("moonshotai/kimi-k2.7-code")).resolves.toBe(262_144);
    await expect(resolveOpenRouterPricing("gpt-5.4-mini")).resolves.toEqual({
      promptUsdPerToken: 0.0000004,
      completionUsdPerToken: 0.0000016,
      cacheReadUsdPerToken: 0.0000001
    });
    // A model that publishes no pricing must read as unknown, not as free.
    await expect(resolveOpenRouterPricing("moonshotai/kimi-k2.7-code")).resolves.toBeUndefined();

    const persisted = await fs.readFile(path.join(home, "cache", "openrouter-model-context.json"), "utf8");
    expect(persisted).toContain('"contextLength":400000');
    expect(persisted).toContain('"promptUsdPerToken":4e-7');
  });

  it("does not choose an ambiguous suffix match", async () => {
    await createHome();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "provider-a/shared-model", context_length: 100_000 },
        { id: "provider-b/shared-model", context_length: 200_000 }
      ]
    }), { status: 200 })));

    await expect(resolveOpenRouterContextWindow("shared-model")).resolves.toBeUndefined();
  });

  it("reuses a fresh disk cache across CrewCoder homes without fetching", async () => {
    const sourceHome = await createHome();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "openai/cached-model", context_length: 123_456 }]
    }), { status: 200 })));
    await expect(resolveOpenRouterContextWindow("cached-model")).resolves.toBe(123_456);

    const targetHome = await createHome();
    await fs.mkdir(path.join(targetHome, "cache"), { recursive: true });
    await fs.copyFile(
      path.join(sourceHome, "cache", "openrouter-model-context.json"),
      path.join(targetHome, "cache", "openrouter-model-context.json")
    );
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(resolveOpenRouterContextWindow("cached-model")).resolves.toBe(123_456);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns no context window when a stale cache cannot be refreshed", async () => {
    const home = await createHome();
    await fs.mkdir(path.join(home, "cache"), { recursive: true });
    await fs.writeFile(path.join(home, "cache", "openrouter-model-context.json"), JSON.stringify({
      version: 2,
      fetchedAt: Date.now() - (25 * 60 * 60 * 1_000),
      models: [{ id: "openai/stale-model", contextLength: 999_999 }]
    }), "utf8");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));

    await expect(resolveOpenRouterContextWindow("stale-model")).resolves.toBeUndefined();
  });
});
