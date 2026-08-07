import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig, writeConfig } from "../core/config.js";
import {
  DEFAULT_EXTENSION_REGISTRY,
  addRegistry,
  clearRegistryCache,
  listRegistrySources,
  isRegistryAlias,
  listConfiguredRegistries,
  loadRegistries,
  parseRegistryIndex,
  removeRegistry,
  resolveRegistryAlias,
  searchRegistries
} from "../extensions/extension-registry-index.js";
import { installExtension, readInstallRecord, resolveInstallSpec } from "../extensions/extension-install.js";

let scratch = "";
let home = "";
const originalHome = process.env.CREWCODER_HOME;

const sampleIndex = {
  version: 1,
  name: "Test Registry",
  extensions: [
    { id: "nextjs-workflows", name: "Next.js Workflows", source: "acme/nextjs-workflows", version: "1.2.0", description: "Release and lint workflows for Next.js apps", keywords: ["nextjs", "release"], contributes: ["workflows"], requiresTrust: true },
    { id: "python-lint", name: "Python Lint Pack", source: "acme/python-lint@v2", description: "Ruff and mypy prompts", keywords: ["python"], contributes: ["skills"] }
  ]
};

async function writeIndex(name: string, doc: unknown): Promise<string> {
  const file = path.join(scratch, name);
  await fs.writeFile(file, JSON.stringify(doc, null, 2), "utf8");
  return file;
}

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-registry-test-"));
  home = path.join(scratch, ".crewcoder");
  process.env.CREWCODER_HOME = home;
  // The built-in registry is on by default. Unit tests must never touch the live host, so
  // every test opts out explicitly and the built-in gets its own stubbed-fetch tests below.
  writeConfig({ ...readConfig(), useDefaultExtensionRegistry: false });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.CREWCODER_HOME;
  else process.env.CREWCODER_HOME = originalHome;
  await fs.rm(scratch, { recursive: true, force: true });
});

describe("parseRegistryIndex", () => {
  it("drops unusable entries instead of failing the whole index", () => {
    const warnings: string[] = [];
    const index = parseRegistryIndex(
      {
        version: 1,
        extensions: [
          { id: "good", name: "Good", source: "acme/good" },
          { id: "../escape", name: "Bad", source: "acme/bad" },
          { id: "no-source", name: "No source" },
          { id: "good", name: "Duplicate", source: "acme/other" },
          "not-an-object"
        ]
      },
      warnings
    );
    expect(index.extensions.map((entry) => entry.id)).toEqual(["good"]);
    expect(warnings).toHaveLength(4);
  });

  it("rejects a non-object document, a missing extensions array, and an unknown version", () => {
    expect(() => parseRegistryIndex([])).toThrow(/must be a JSON object/);
    expect(() => parseRegistryIndex({ version: 1 })).toThrow(/extensions/);
    expect(() => parseRegistryIndex({ version: 9, extensions: [] })).toThrow(/version/);
  });
});

describe("isRegistryAlias", () => {
  it("only treats bare names as aliases", () => {
    expect(isRegistryAlias("nextjs-workflows")).toBe(true);
    expect(isRegistryAlias("nextjs-workflows@v1")).toBe(true);
    expect(isRegistryAlias("acme/nextjs-workflows")).toBe(false);
    expect(isRegistryAlias("https://example.com/x.git")).toBe(false);
    expect(isRegistryAlias("git@github.com:acme/pack.git")).toBe(false);
    expect(isRegistryAlias("./local")).toBe(false);
    expect(isRegistryAlias("~/local")).toBe(false);
  });
});

describe("registry configuration", () => {
  it("adds, lists, and removes registries idempotently", async () => {
    const file = await writeIndex("registry.json", sampleIndex);
    addRegistry(file);
    addRegistry(file);
    expect(listConfiguredRegistries()).toEqual([file]);
    expect(removeRegistry(file).removed).toBe(true);
    expect(removeRegistry(file).removed).toBe(false);
    expect(listConfiguredRegistries()).toEqual([]);
  });
});

describe("the built-in registry", () => {
  it("is searched by default and marked as built-in", async () => {
    writeConfig({ ...readConfig(), useDefaultExtensionRegistry: true });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(sampleIndex), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchRegistries("nextjs");
    expect(fetchMock).toHaveBeenCalledWith(DEFAULT_EXTENSION_REGISTRY, expect.anything());
    expect(result.registries).toHaveLength(1);
    expect(result.registries[0].builtin).toBe(true);
    expect(result.hits).toHaveLength(1);
  });

  it("is disabled by removing its URL and re-enabled by adding it back", () => {
    writeConfig({ ...readConfig(), useDefaultExtensionRegistry: true });
    expect(listRegistrySources()).toEqual([{ url: DEFAULT_EXTENSION_REGISTRY, builtin: true }]);

    expect(removeRegistry(DEFAULT_EXTENSION_REGISTRY).removed).toBe(true);
    expect(readConfig().useDefaultExtensionRegistry).toBe(false);
    expect(listRegistrySources()).toEqual([]);
    expect(removeRegistry(DEFAULT_EXTENSION_REGISTRY).removed).toBe(false);

    addRegistry(DEFAULT_EXTENSION_REGISTRY);
    expect(readConfig().useDefaultExtensionRegistry).toBe(true);
    // Re-enabling must not duplicate it into the user list.
    expect(readConfig().extensionRegistries).toEqual([]);
    expect(listRegistrySources()).toHaveLength(1);
  });

  it("is searched after user registries, so a private index shadows it", async () => {
    writeConfig({ ...readConfig(), useDefaultExtensionRegistry: true });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(sampleIndex), { status: 200 })));
    addRegistry(await writeIndex("private.json", { version: 1, name: "Private", extensions: [{ id: "python-lint", name: "Internal", source: "internal/python-lint" }] }));

    expect(listRegistrySources().map((source) => source.builtin)).toEqual([false, true]);
    expect((await resolveRegistryAlias("python-lint"))?.entry.source).toBe("internal/python-lint");
  });
});

describe("searchRegistries", () => {
  it("ranks exact id matches above description matches and flags installed entries", async () => {
    addRegistry(await writeIndex("registry.json", sampleIndex));
    await fs.mkdir(path.join(home, "extensions", "python-lint"), { recursive: true });

    const result = await searchRegistries("python");
    expect(result.hits.map((hit) => hit.entry.id)).toEqual(["python-lint"]);
    expect(result.hits[0].installed).toBe(true);

    const all = await searchRegistries("");
    expect(all.hits).toHaveLength(2);
  });

  it("requires every query term to match", async () => {
    addRegistry(await writeIndex("registry.json", sampleIndex));
    expect((await searchRegistries("nextjs release")).hits).toHaveLength(1);
    expect((await searchRegistries("nextjs python")).hits).toHaveLength(0);
  });

  it("reports a broken registry without losing hits from the healthy ones", async () => {
    addRegistry(await writeIndex("registry.json", sampleIndex));
    addRegistry(path.join(scratch, "missing.json"));
    const result = await searchRegistries("nextjs");
    expect(result.hits).toHaveLength(1);
    expect(result.registries.filter((entry) => entry.error)).toHaveLength(1);
  });
});

describe("remote registries", () => {
  it("caches a fetched index and serves it without a second request", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(sampleIndex), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    addRegistry("https://example.com/registry.json");

    expect((await loadRegistries())[0].fromCache).toBe(false);
    const cached = (await loadRegistries())[0];
    expect(cached.fromCache).toBe(true);
    expect(cached.index?.extensions).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await clearRegistryCache();
    await loadRegistries();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to a stale cache when a refetch fails, and says so", async () => {
    const fetchMock = vi
      .fn(async () => new Response(JSON.stringify(sampleIndex), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify(sampleIndex), { status: 200 }))
      .mockImplementation(async () => { throw new Error("network down"); });
    vi.stubGlobal("fetch", fetchMock);
    addRegistry("https://example.com/registry.json");

    await loadRegistries();
    const stale = (await loadRegistries({ refresh: true }))[0];
    expect(stale.index?.extensions).toHaveLength(2);
    expect(stale.fromCache).toBe(true);
    expect(stale.error).toMatch(/network down/);
  });

  it("surfaces an HTTP failure with no cache as a registry error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" })));
    addRegistry("https://example.com/registry.json");
    const loaded = (await loadRegistries())[0];
    expect(loaded.index).toBeUndefined();
    expect(loaded.error).toMatch(/404/);
  });
});

describe("resolveRegistryAlias", () => {
  it("resolves by id and lets a user-typed ref override the registry ref", async () => {
    addRegistry(await writeIndex("registry.json", sampleIndex));
    expect((await resolveRegistryAlias("nextjs-workflows"))?.entry.source).toBe("acme/nextjs-workflows");
    expect((await resolveRegistryAlias("NEXTJS-WORKFLOWS"))?.entry.source).toBe("acme/nextjs-workflows");
    expect((await resolveRegistryAlias("python-lint"))?.entry.source).toBe("acme/python-lint@v2");
    expect((await resolveRegistryAlias("python-lint@v3"))?.entry.source).toBe("acme/python-lint@v3");
    expect(await resolveRegistryAlias("unknown-pack")).toBeUndefined();
  });

  it("lets the first configured registry shadow later ones", async () => {
    addRegistry(await writeIndex("private.json", { version: 1, name: "Private", extensions: [{ id: "python-lint", name: "Internal", source: "internal/python-lint" }] }));
    addRegistry(await writeIndex("registry.json", sampleIndex));
    const hit = await resolveRegistryAlias("python-lint");
    expect(hit?.entry.source).toBe("internal/python-lint");
    expect(hit?.registryName).toBe("Private");
  });
});

describe("install alias resolution", () => {
  it("never routes an explicit source through a registry", async () => {
    addRegistry(await writeIndex("registry.json", sampleIndex));
    expect(await resolveInstallSpec("acme/other-pack")).toEqual({ spec: "acme/other-pack" });
    expect(await resolveInstallSpec("./local-pack")).toEqual({ spec: "./local-pack" });
    expect(await resolveInstallSpec("nextjs-workflows", { from: "./local-pack" })).toEqual({ spec: "nextjs-workflows" });
  });

  it("explains an unresolvable bare name based on whether registries exist", async () => {
    await expect(resolveInstallSpec("nextjs-workflows")).rejects.toThrow(/No registries are enabled/);
    addRegistry(await writeIndex("registry.json", sampleIndex));
    await expect(resolveInstallSpec("unknown-pack")).rejects.toThrow(/extension search unknown-pack/);
  });

  it("installs from a registry alias and records the provenance", async () => {
    const source = path.join(scratch, "demo-pack");
    await fs.mkdir(source, { recursive: true });
    await fs.writeFile(
      path.join(source, "crewcoder.extension.json"),
      JSON.stringify({ id: "demo-pack", name: "Demo Pack", version: "1.0.0", crewcoder: { apiVersion: "0.1" } }),
      "utf8"
    );
    const registryFile = await writeIndex("registry.json", { version: 1, name: "Local", extensions: [{ id: "demo-pack", name: "Demo Pack", source }] });
    addRegistry(registryFile);

    const result = await installExtension("demo-pack");
    expect(result.id).toBe("demo-pack");
    expect(result.record.alias).toBe("demo-pack");
    expect(result.record.registry).toBe(registryFile);
    expect(result.record.spec).toBe(source);
    expect((await readInstallRecord(result.dir))?.alias).toBe("demo-pack");
  });
});
