import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ensureCrewCoderHome } from "../core/crewcoder-home.js";
import { CREWCODER_VERSION } from "../core/version.js";
import { listCodexModels } from "./codex-app-server-provider.js";
import { resolveClaudeExecutable } from "./claude-executable.js";
import type { ProviderDefinition, ProviderModel } from "./types.js";

const CACHE_MS = 5 * 60_000;
const RETRY_MS = 30_000;
const DISCOVERY_TIMEOUT_MS = 5_000;

type Catalog = { models: ProviderModel[]; defaultModel?: string };
type CacheEntry = { key: string; expires: number; catalog?: Catalog; pending?: Promise<Catalog | undefined> };
const cache = new Map<string, CacheEntry>();

/** Native catalogs are best-effort: unavailable discovery never prevents a run. */
export async function hydrateNativeProviderModels(provider: ProviderDefinition): Promise<ProviderDefinition> {
  if (provider.kind !== "builtin" || !["codex-cli", "claude"].includes(provider.id)) return provider;
  const key = catalogKey(provider);
  let entry = cache.get(provider.id);
  if (!entry || entry.key !== key) {
    entry = { key, expires: 0 };
    cache.set(provider.id, entry);
  }
  if (!entry.pending && Date.now() >= entry.expires) {
    const current = entry;
    current.pending = discover(provider).then((catalog) => {
      if (catalog) current.catalog = catalog;
      current.expires = Date.now() + (catalog ? CACHE_MS : RETRY_MS);
      return current.catalog;
    }).finally(() => { current.pending = undefined; });
  }
  const catalog = entry.pending ? await entry.pending : entry.catalog;
  if (!catalog) return provider;
  const modelCatalog = catalog.models.map((model) => ({
    ...provider.modelCatalog?.find((known) => known.id === model.id),
    ...model
  }));
  const models = modelCatalog.map((model) => model.id);
  return {
    ...provider,
    models,
    modelCatalog,
    defaultModel: models.includes(provider.defaultModel ?? "") ? provider.defaultModel : catalog.defaultModel ?? models[0]
  };
}

async function discover(provider: ProviderDefinition): Promise<Catalog | undefined> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    // Race as well as abort: an unavailable SDK must not hang the caller even if it ignores cancellation.
    return await Promise.race([
      (async () => {
        const rows: unknown = provider.id === "claude"
          ? await listClaudeModels(controller)
          : await listCodexModels(provider, controller.signal);
        return parseCatalog(rows, provider.id === "claude");
      })(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => { controller.abort(); resolve(undefined); }, DISCOVERY_TIMEOUT_MS);
      })
    ]);
  } catch {
    // Login, executable, offline and malformed-catalog failures retain the last good or bundled list.
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

async function listClaudeModels(controller: AbortController): Promise<unknown> {
  // Hold stdin open until discovery finishes, without sending an inference prompt.
  const prompt: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      if (!controller.signal.aborted) {
        await new Promise<void>((resolve) => controller.signal.addEventListener("abort", () => resolve(), { once: true }));
      }
    }
  };
  const q = query({
    prompt,
    options: {
      cwd: ensureCrewCoderHome().root,
      abortController: controller,
      pathToClaudeCodeExecutable: resolveClaudeExecutable(),
      env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: `crewcoder/${CREWCODER_VERSION}` },
      persistSession: false,
      settingSources: [],
      settings: { disableAllHooks: true },
      tools: [],
      skills: [],
      mcpServers: {},
      strictMcpConfig: true
    }
  });
  const abort = () => q.close();
  controller.signal.addEventListener("abort", abort, { once: true });
  try {
    return await q.supportedModels();
  } finally {
    controller.signal.removeEventListener("abort", abort);
    q.close();
  }
}

function parseCatalog(rows: unknown, claude: boolean): Catalog | undefined {
  if (!Array.isArray(rows) || rows.length > 1_000) return undefined;
  const models = new Map<string, ProviderModel>();
  let defaultModel: string | undefined;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (record.hidden === true) continue;
    const id = modelId(claude ? record.value : record.model ?? record.id);
    if (!id) continue;
    const title = record.displayName;
    const contextWindow = typeof record.contextWindow === "number" && Number.isSafeInteger(record.contextWindow) && record.contextWindow > 0
      ? record.contextWindow : undefined;
    const metadata = {
      ...(typeof title === "string" && title.trim() ? { title: title.trim().slice(0, 256) } : {}),
      ...(contextWindow ? { contextWindow } : {})
    };
    if (!models.has(id)) models.set(id, { id, ...metadata });
    // Claude often reports aliases (sonnet/opus). Include the canonical ids too so
    // explicit saved selections and their known context metadata remain selectable.
    const resolved = claude ? modelId(record.resolvedModel) : undefined;
    if (resolved && !models.has(resolved)) models.set(resolved, { id: resolved, ...metadata });
    if (record.isDefault === true && !defaultModel) defaultModel = id;
  }
  return models.size ? { models: [...models.values()], defaultModel } : undefined;
}

function modelId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value.trim())
    ? value.trim() : undefined;
}

function catalogKey(provider: ProviderDefinition): string {
  const root = ensureCrewCoderHome().root;
  const executable = provider.id === "claude" ? resolveClaudeExecutable() : process.env.CREWCODER_CODEX_PATH;
  let executableStamp = "";
  if (executable) {
    try {
      const stat = fs.statSync(executable);
      executableStamp = `${stat.mtimeMs}:${stat.size}`;
    } catch { /* Discovery reports an unavailable executable through its fallback. */ }
  }
  const nativeHome = provider.id === "claude"
    ? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude")
    : process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  let authStamp = "";
  try {
    const stat = fs.statSync(path.join(nativeHome, provider.id === "claude" ? ".credentials.json" : "auth.json"));
    authStamp = `${stat.mtimeMs}:${stat.size}`;
  } catch { /* A CLI may use the OS keychain instead. The short TTL still refreshes it. */ }
  // Scope to account/config changes without retaining raw secrets in cache keys.
  return createHash("sha256").update(JSON.stringify([
    root, nativeHome, authStamp, executable, executableStamp,
    provider.id === "claude" ? [process.env.CLAUDE_CODE_OAUTH_TOKEN, process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_BASE_URL] : undefined
  ])).digest("hex");
}
