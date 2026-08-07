import fs from "node:fs/promises";
import path from "node:path";
import { ensureCrewCoderHome } from "../core/crewcoder-home.js";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_FILE_NAME = "openrouter-model-context.json";
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const FETCH_TIMEOUT_MS = 5_000;
const CACHE_VERSION = 2;

/** USD per single token, as published by OpenRouter. */
export type OpenRouterModelPricing = {
  promptUsdPerToken: number;
  completionUsdPerToken: number;
  cacheReadUsdPerToken?: number;
  cacheWriteUsdPerToken?: number;
};

type OpenRouterModelEntry = {
  id: string;
  contextLength?: number;
  pricing?: OpenRouterModelPricing;
};

type OpenRouterCatalogCache = {
  version: typeof CACHE_VERSION;
  fetchedAt: number;
  models: OpenRouterModelEntry[];
};

const memoryCache = new Map<string, OpenRouterCatalogCache>();
const pendingLoads = new Map<string, Promise<OpenRouterCatalogCache | undefined>>();

export async function resolveOpenRouterContextWindow(modelId: string): Promise<number | undefined> {
  return (await findModelEntry(modelId))?.contextLength;
}

export async function resolveOpenRouterPricing(modelId: string): Promise<OpenRouterModelPricing | undefined> {
  return (await findModelEntry(modelId))?.pricing;
}

async function findModelEntry(modelId: string): Promise<OpenRouterModelEntry | undefined> {
  const normalized = modelId.trim();
  if (!normalized) return undefined;
  const cache = await loadCatalog();
  if (!cache) return undefined;
  const exact = cache.models.find((model) => model.id === normalized);
  if (exact) return exact;

  // A bare model id (`claude-sonnet-4-5`) resolves only when exactly one vendor
  // namespace offers it; an ambiguous match must stay unresolved rather than
  // silently pick someone else's price.
  const suffix = `/${normalized}`;
  const suffixMatches = cache.models.filter((model) => model.id.endsWith(suffix));
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}

async function loadCatalog(): Promise<OpenRouterCatalogCache | undefined> {
  const cacheFile = path.join(ensureCrewCoderHome().cacheDir, CACHE_FILE_NAME);
  const now = Date.now();
  const memory = memoryCache.get(cacheFile);
  if (memory && isFresh(memory, now)) return memory;

  const pending = pendingLoads.get(cacheFile);
  if (pending) return pending;

  const load = loadCatalogUncached(cacheFile, now).finally(() => pendingLoads.delete(cacheFile));
  pendingLoads.set(cacheFile, load);
  return load;
}

async function loadCatalogUncached(cacheFile: string, now: number): Promise<OpenRouterCatalogCache | undefined> {
  const diskCache = await readCache(cacheFile);
  if (diskCache && isFresh(diskCache, now)) {
    memoryCache.set(cacheFile, diskCache);
    return diskCache;
  }

  const fetched = await fetchCatalog(now);
  if (!fetched) return undefined;
  memoryCache.set(cacheFile, fetched);
  await writeCache(cacheFile, fetched).catch(() => undefined);
  return fetched;
}

async function fetchCatalog(fetchedAt: number): Promise<OpenRouterCatalogCache | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(OPENROUTER_MODELS_URL, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) return undefined;
    const models = parseModels(await response.json());
    if (!models.length) return undefined;
    return { version: CACHE_VERSION, fetchedAt, models };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

function parseModels(payload: unknown): OpenRouterModelEntry[] {
  if (!isRecord(payload)) return [];
  const data = payload.data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((value) => {
    if (!isRecord(value)) return [];
    if (typeof value.id !== "string" || !value.id.trim()) return [];
    return toEntry(value.id.trim(), positiveInteger(value.context_length), parsePricing(value.pricing));
  });
}

function parsePricing(value: unknown): OpenRouterModelPricing | undefined {
  if (!isRecord(value)) return undefined;
  const prompt = usdPerToken(value.prompt);
  const completion = usdPerToken(value.completion);
  if (prompt === undefined || completion === undefined) return undefined;
  return {
    promptUsdPerToken: prompt,
    completionUsdPerToken: completion,
    ...optionalRate("cacheReadUsdPerToken", usdPerToken(value.input_cache_read)),
    ...optionalRate("cacheWriteUsdPerToken", usdPerToken(value.input_cache_write))
  };
}

/** OpenRouter publishes per-token prices as strings; `-1` means "not priced". */
function usdPerToken(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function optionalRate(key: string, value: number | undefined): Record<string, number> {
  return value === undefined ? {} : { [key]: value };
}

async function readCache(cacheFile: string): Promise<OpenRouterCatalogCache | undefined> {
  try {
    return parseCache(JSON.parse(await fs.readFile(cacheFile, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function parseCache(value: unknown): OpenRouterCatalogCache | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== CACHE_VERSION || typeof value.fetchedAt !== "number" || !Number.isFinite(value.fetchedAt) || !Array.isArray(value.models)) return undefined;
  const models = value.models.flatMap((item) => {
    if (!isRecord(item)) return [];
    if (typeof item.id !== "string" || !item.id.trim()) return [];
    return toEntry(item.id.trim(), positiveInteger(item.contextLength), parseCachedPricing(item.pricing));
  });
  return models.length ? { version: CACHE_VERSION, fetchedAt: value.fetchedAt, models } : undefined;
}

function parseCachedPricing(value: unknown): OpenRouterModelPricing | undefined {
  if (!isRecord(value)) return undefined;
  const prompt = usdPerToken(value.promptUsdPerToken);
  const completion = usdPerToken(value.completionUsdPerToken);
  if (prompt === undefined || completion === undefined) return undefined;
  return {
    promptUsdPerToken: prompt,
    completionUsdPerToken: completion,
    ...optionalRate("cacheReadUsdPerToken", usdPerToken(value.cacheReadUsdPerToken)),
    ...optionalRate("cacheWriteUsdPerToken", usdPerToken(value.cacheWriteUsdPerToken))
  };
}

function toEntry(id: string, contextLength: number | undefined, pricing: OpenRouterModelPricing | undefined): OpenRouterModelEntry[] {
  if (contextLength === undefined && !pricing) return [];
  return [{ id, ...(contextLength === undefined ? {} : { contextLength }), ...(pricing ? { pricing } : {}) }];
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFresh(cache: OpenRouterCatalogCache, now: number): boolean {
  return cache.fetchedAt <= now && now - cache.fetchedAt < CACHE_TTL_MS;
}

async function writeCache(cacheFile: string, cache: OpenRouterCatalogCache): Promise<void> {
  await fs.mkdir(path.dirname(cacheFile), { recursive: true });
  const temporary = `${cacheFile}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(cache)}\n`, "utf8");
    await fs.rename(temporary, cacheFile);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
