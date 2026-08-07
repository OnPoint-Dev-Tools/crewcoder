import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveModel } from "../providers/model-registry.js";

let temporaryHome: string | undefined;

async function useTemporaryHome(): Promise<string> {
  temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-model-registry-"));
  vi.stubEnv("CREWCODER_HOME", temporaryHome);
  return temporaryHome;
}

describe("model registry context windows", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (temporaryHome) await fs.rm(temporaryHome, { recursive: true, force: true });
    temporaryHome = undefined;
  });

  it("enriches models from the OpenRouter catalog", async () => {
    await useTemporaryHome();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "openai/gpt-5.4-mini", context_length: 400_000 }]
    }), { status: 200 })));

    const resolved = await resolveModel("codex", "gpt-5.4-mini");

    expect(resolved?.metadata).toEqual({ id: "gpt-5.4-mini", contextWindow: 400_000 });
  });

  it("prefers provider-declared metadata without fetching OpenRouter", async () => {
    const home = await useTemporaryHome();
    const extensionDir = path.join(home, "extensions", "declared-provider");
    await fs.mkdir(extensionDir, { recursive: true });
    await fs.writeFile(path.join(extensionDir, "crewcoder.extension.json"), JSON.stringify({
      id: "declared-provider",
      name: "Declared Provider",
      version: "1.0.0",
      crewcoder: { apiVersion: "0.1" },
      contributes: {
        providers: [{
          id: "declared",
          title: "Declared",
          runtime: "process",
          command: "echo",
          args: [],
          modelCatalog: [{ id: "declared-model", contextWindow: 64_000 }],
          defaultModel: "declared-model"
        }]
      }
    }), "utf8");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const resolved = await resolveModel("declared", "declared-model");

    expect(resolved?.metadata?.contextWindow).toBe(64_000);
    expect(fetch).not.toHaveBeenCalled();
  });
});
