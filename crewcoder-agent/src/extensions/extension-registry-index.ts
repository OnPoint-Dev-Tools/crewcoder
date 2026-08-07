// Extension registry index.
//
// A registry is a plain JSON document listing extensions and the source spec that
// `crewcoder extension install` already understands. That is the whole design: the index
// is a *discovery* layer, never an acquisition layer. Searching resolves a name to an
// `owner/repo` (or git URL / local path) and hands it to the existing install pipeline,
// which still stages, validates, and leaves the extension prompt-only.
//
// Registries are user-configured (`config.extensionRegistries`); there is no built-in
// default index. A registry that is unreachable or malformed degrades to an error on that
// one registry — search still returns hits from the others.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ensureCrewCoderHome } from "../core/crewcoder-home.js";
import { readConfig, writeConfig } from "../core/config.js";

/**
 * The first-party registry. Path-versioned (`/v1/`) because `RegistryIndex.version` is a hard
 * gate: when a v2 format ships, old builds must keep reading a v1 document that still exists.
 */
export const DEFAULT_EXTENSION_REGISTRY = "https://crewcoder-extensions.cortex-ai.icu/v1/index.json";

const cacheDirName = "registries";
const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_INDEX_BYTES = 8 * 1024 * 1024;

/** One extension as advertised by a registry. `source` is any spec `extension install` accepts. */
export type RegistryEntry = {
  id: string;
  name: string;
  source: string;
  description?: string;
  version?: string;
  author?: string;
  homepage?: string;
  keywords: string[];
  /** Contribution point names the registry claims this extension declares. Advisory only. */
  contributes: string[];
  /** Registry-declared hint that the package ships executable contributions. Advisory only. */
  requiresTrust: boolean;
};

export type RegistryIndex = {
  version: number;
  name?: string;
  description?: string;
  updatedAt?: string;
  extensions: RegistryEntry[];
};

export type RegistrySource = {
  url: string;
  /** True for the first-party registry, which is a config flag rather than a list entry. */
  builtin: boolean;
};

export type LoadedRegistry = {
  /** The registry location exactly as configured. */
  url: string;
  name: string;
  builtin: boolean;
  index?: RegistryIndex;
  fetchedAt?: string;
  fromCache: boolean;
  /** Set when this registry could not be loaded; the other registries still load. */
  error?: string;
};

export type RegistrySearchHit = {
  entry: RegistryEntry;
  registryUrl: string;
  registryName: string;
  score: number;
  /** True when an extension with this id is already present in `<home>/extensions`. */
  installed: boolean;
};

export type RegistryLoadOptions = {
  /** Ignore cached copies and re-fetch. */
  refresh?: boolean;
  /** Restrict to registries whose URL or name contains this string. */
  registry?: string;
  /** Cache lifetime for remote registries. */
  ttlMs?: number;
};

export type RegistrySearchOptions = RegistryLoadOptions & { limit?: number };

export type RegistrySearchResult = {
  hits: RegistrySearchHit[];
  registries: LoadedRegistry[];
};

/** Registry entries are only useful if their id is also a safe install directory name. */
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * A bare name is anything that is not already a git URL, `owner/repo`, or a filesystem path.
 * Only these go through registry alias resolution, so an explicit spec always wins.
 */
export function isRegistryAlias(spec: string): boolean {
  const trimmed = spec.trim();
  if (!trimmed) return false;
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes(":")) return false;
  if (trimmed.startsWith(".") || trimmed.startsWith("~")) return false;
  const at = trimmed.indexOf("@");
  const base = at > 0 ? trimmed.slice(0, at) : trimmed;
  return safeIdPattern.test(base);
}

/**
 * Every registry to search, in precedence order. User registries come **first** so a private
 * index can shadow an id published in the first-party one.
 */
export function listRegistrySources(): RegistrySource[] {
  const config = readConfig();
  const user = config.extensionRegistries.map((url) => ({ url, builtin: false }));
  return config.useDefaultExtensionRegistry ? [...user, { url: DEFAULT_EXTENSION_REGISTRY, builtin: true }] : user;
}

export function listConfiguredRegistries(): string[] {
  return listRegistrySources().map((source) => source.url);
}

export function addRegistry(url: string): string[] {
  const normalized = normalizeRegistryUrl(url);
  const config = readConfig();
  // Re-adding the first-party registry re-enables the flag instead of duplicating the URL.
  if (normalized === DEFAULT_EXTENSION_REGISTRY) {
    if (!config.useDefaultExtensionRegistry) writeConfig({ ...config, useDefaultExtensionRegistry: true });
    return listConfiguredRegistries();
  }
  if (config.extensionRegistries.includes(normalized)) return listConfiguredRegistries();
  writeConfig({ ...config, extensionRegistries: [...config.extensionRegistries, normalized] });
  return listConfiguredRegistries();
}

export function removeRegistry(url: string): { removed: boolean; registries: string[] } {
  const normalized = normalizeRegistryUrl(url);
  const config = readConfig();
  // The first-party registry is not a list entry, so removing it means turning the flag off.
  if (normalized === DEFAULT_EXTENSION_REGISTRY) {
    if (!config.useDefaultExtensionRegistry) return { removed: false, registries: listConfiguredRegistries() };
    writeConfig({ ...config, useDefaultExtensionRegistry: false });
    return { removed: true, registries: listConfiguredRegistries() };
  }
  const extensionRegistries = config.extensionRegistries.filter((entry) => entry !== normalized && entry !== url.trim());
  if (extensionRegistries.length === config.extensionRegistries.length) return { removed: false, registries: listConfiguredRegistries() };
  writeConfig({ ...config, extensionRegistries });
  return { removed: true, registries: listConfiguredRegistries() };
}

/** Normalize a configured registry location: URLs stay verbatim, paths become absolute. */
export function normalizeRegistryUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new Error("Registry URL is required, for example: crewcoder extension registry add https://example.com/registry.json");
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith("file:")) return trimmed;
  return path.resolve(trimmed);
}

/**
 * Validate a raw registry document. Malformed *entries* are dropped with a warning rather than
 * failing the whole registry, because one bad row should not hide an otherwise healthy index.
 */
export function parseRegistryIndex(raw: unknown, warnings: string[] = []): RegistryIndex {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Registry index must be a JSON object.");
  const doc = raw as Record<string, unknown>;
  const rows = doc.extensions;
  if (!Array.isArray(rows)) throw new Error("Registry index must have an `extensions` array.");
  const version = typeof doc.version === "number" ? doc.version : 1;
  if (version !== 1) throw new Error(`Unsupported registry index version: ${version}. This CrewCoder build understands version 1.`);

  const seen = new Set<string>();
  const extensions: RegistryEntry[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) { warnings.push("Skipped a registry entry that is not an object."); continue; }
    const item = row as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const source = typeof item.source === "string" ? item.source.trim() : "";
    if (!id || !safeIdPattern.test(id)) { warnings.push(`Skipped registry entry with an unusable id: ${JSON.stringify(item.id)}`); continue; }
    if (!source) { warnings.push(`Skipped registry entry ${id}: no install source.`); continue; }
    if (seen.has(id)) { warnings.push(`Skipped duplicate registry entry: ${id}`); continue; }
    seen.add(id);
    extensions.push({
      id,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : id,
      source,
      description: typeof item.description === "string" ? item.description : undefined,
      version: typeof item.version === "string" ? item.version : undefined,
      author: typeof item.author === "string" ? item.author : undefined,
      homepage: typeof item.homepage === "string" ? item.homepage : undefined,
      keywords: Array.isArray(item.keywords) ? item.keywords.filter((keyword): keyword is string => typeof keyword === "string") : [],
      contributes: Array.isArray(item.contributes) ? item.contributes.filter((point): point is string => typeof point === "string") : [],
      requiresTrust: item.requiresTrust === true
    });
  }
  return {
    version: 1,
    name: typeof doc.name === "string" ? doc.name : undefined,
    description: typeof doc.description === "string" ? doc.description : undefined,
    updatedAt: typeof doc.updatedAt === "string" ? doc.updatedAt : undefined,
    extensions
  };
}

/** Load every configured registry. Failures are reported per registry, never thrown. */
export async function loadRegistries(options: RegistryLoadOptions = {}): Promise<LoadedRegistry[]> {
  const filter = options.registry?.trim().toLowerCase();
  const sources = listRegistrySources();
  const selected = filter ? sources.filter((source) => source.url.toLowerCase().includes(filter)) : sources;
  return Promise.all(selected.map((source) => loadRegistry(source.url, options)));
}

export async function loadRegistry(url: string, options: RegistryLoadOptions = {}): Promise<LoadedRegistry> {
  const cachePath = registryCachePath(url);
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const remote = isRemote(url);
  const builtin = url === DEFAULT_EXTENSION_REGISTRY;

  if (remote && !options.refresh) {
    const cached = await readCache(cachePath, ttlMs);
    if (cached) return { url, name: cached.index.name ?? url, builtin, index: cached.index, fetchedAt: cached.fetchedAt, fromCache: true };
  }

  try {
    const body = await readRegistryBody(url);
    const index = parseRegistryIndex(JSON.parse(body));
    const fetchedAt = new Date().toISOString();
    if (remote) await writeCache(cachePath, { url, fetchedAt, index });
    return { url, name: index.name ?? url, builtin, index, fetchedAt, fromCache: false };
  } catch (error) {
    // A stale cache beats no registry at all when the network is down; say it is stale.
    if (remote) {
      const stale = await readCache(cachePath, Number.POSITIVE_INFINITY);
      if (stale) {
        return {
          url,
          name: stale.index.name ?? url,
          builtin,
          index: stale.index,
          fetchedAt: stale.fetchedAt,
          fromCache: true,
          error: `Using cached copy from ${stale.fetchedAt}: ${errorMessage(error)}`
        };
      }
    }
    return { url, name: url, builtin, fromCache: false, error: errorMessage(error) };
  }
}

/** Rank registry entries against a query. An empty query lists everything. */
export async function searchRegistries(query: string, options: RegistrySearchOptions = {}): Promise<RegistrySearchResult> {
  const registries = await loadRegistries(options);
  const installed = listInstalledExtensionIds();
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);

  const hits: RegistrySearchHit[] = [];
  for (const registry of registries) {
    for (const entry of registry.index?.extensions ?? []) {
      const score = scoreEntry(entry, terms);
      if (score <= 0) continue;
      hits.push({ entry, registryUrl: registry.url, registryName: registry.name, score, installed: installed.has(entry.id) });
    }
  }
  hits.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));
  const limit = options.limit && options.limit > 0 ? options.limit : hits.length;
  return { hits: hits.slice(0, limit), registries };
}

/**
 * Resolve a bare extension name to a registry entry. First registry in configuration order
 * wins, so a user's private registry can shadow a public one by being listed first.
 */
export async function resolveRegistryAlias(alias: string, options: RegistryLoadOptions = {}): Promise<RegistrySearchHit | undefined> {
  const trimmed = alias.trim();
  const at = trimmed.indexOf("@");
  const id = (at > 0 ? trimmed.slice(0, at) : trimmed).toLowerCase();
  const ref = at > 0 ? trimmed.slice(at + 1) : undefined;
  if (ref !== undefined && !ref) throw new Error(`Extension ref must not be empty: ${alias}`);

  const registries = await loadRegistries(options);
  const installed = listInstalledExtensionIds();
  for (const registry of registries) {
    const entry = registry.index?.extensions.find((candidate) => candidate.id.toLowerCase() === id);
    if (!entry) continue;
    // An `@ref` typed by the user pins the install; it overrides any ref baked into the source.
    const source = ref ? applyRef(entry.source, ref) : entry.source;
    return {
      entry: { ...entry, source },
      registryUrl: registry.url,
      registryName: registry.name,
      score: 100,
      installed: installed.has(entry.id)
    };
  }
  return undefined;
}

export function listInstalledExtensionIds(): Set<string> {
  const home = ensureCrewCoderHome();
  try {
    return new Set(
      fsSync.readdirSync(home.extensionsDir, { withFileTypes: true })
        .filter((item) => item.isDirectory() && !item.name.startsWith("."))
        .map((item) => item.name)
    );
  } catch {
    return new Set();
  }
}

/** Delete every cached registry document. */
export async function clearRegistryCache(): Promise<number> {
  const dir = registryCacheDir();
  let removed = 0;
  try {
    for (const file of await fs.readdir(dir)) {
      if (!file.endsWith(".json")) continue;
      await fs.rm(path.join(dir, file), { force: true });
      removed += 1;
    }
  } catch {
    return removed;
  }
  return removed;
}

function applyRef(source: string, ref: string): string {
  const hashIndex = source.indexOf("#");
  const base = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  const subdir = hashIndex >= 0 ? source.slice(hashIndex) : "";
  // Strip a ref the registry already pinned, using the same "@ after the last / and :" rule
  // that parseExtensionSpec uses so userinfo in a URL is not mistaken for a ref.
  const at = base.lastIndexOf("@");
  const hasRef = at > 0 && at > base.lastIndexOf("/") && at > base.lastIndexOf(":");
  const withoutRef = hasRef ? base.slice(0, at) : base;
  return `${withoutRef}@${ref}${subdir}`;
}

function scoreEntry(entry: RegistryEntry, terms: string[]): number {
  if (!terms.length) return 1;
  const id = entry.id.toLowerCase();
  const name = entry.name.toLowerCase();
  const description = (entry.description ?? "").toLowerCase();
  const keywords = entry.keywords.map((keyword) => keyword.toLowerCase());
  const contributes = entry.contributes.map((point) => point.toLowerCase());

  let total = 0;
  for (const term of terms) {
    let best = 0;
    if (id === term) best = 100;
    else if (id.includes(term)) best = 45;
    if (name.includes(term)) best = Math.max(best, 30);
    if (keywords.some((keyword) => keyword === term)) best = Math.max(best, 25);
    else if (keywords.some((keyword) => keyword.includes(term))) best = Math.max(best, 15);
    if (contributes.some((point) => point === term)) best = Math.max(best, 12);
    if (description.includes(term)) best = Math.max(best, 8);
    // Every term must match something, so multi-word queries narrow instead of widening.
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

function isRemote(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

async function readRegistryBody(url: string): Promise<string> {
  if (isRemote(url)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" }, redirect: "follow" });
      if (!response.ok) throw new Error(`Registry request failed: ${response.status} ${response.statusText}`);
      const body = await response.text();
      if (body.length > MAX_INDEX_BYTES) throw new Error(`Registry index is larger than ${MAX_INDEX_BYTES} bytes.`);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }
  const filePath = url.startsWith("file:") ? fileURLToPath(url) : url;
  return fs.readFile(filePath, "utf8");
}

type RegistryCacheRecord = { url: string; fetchedAt: string; index: RegistryIndex };

function registryCacheDir(): string {
  return path.join(ensureCrewCoderHome().cacheDir, cacheDirName);
}

function registryCachePath(url: string): string {
  return path.join(registryCacheDir(), `${createHash("sha256").update(url).digest("hex").slice(0, 32)}.json`);
}

async function readCache(cachePath: string, ttlMs: number): Promise<RegistryCacheRecord | undefined> {
  try {
    const record = JSON.parse(await fs.readFile(cachePath, "utf8")) as RegistryCacheRecord;
    if (!record?.fetchedAt || !record.index) return undefined;
    const age = Date.now() - Date.parse(record.fetchedAt);
    if (!Number.isFinite(age) || age < 0) return undefined;
    if (age > ttlMs) return undefined;
    return { ...record, index: parseRegistryIndex(record.index) };
  } catch {
    return undefined;
  }
}

async function writeCache(cachePath: string, record: RegistryCacheRecord): Promise<void> {
  try {
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  } catch {
    // A cache write failure must never fail a search.
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
