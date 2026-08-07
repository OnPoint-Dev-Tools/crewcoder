import { builtinProviders } from "./builtins.js";
import type { ProviderDefinition } from "./types.js";
import { providersFromExtensions } from "../extensions/extension-loader.js";
import { listEnabledExtensions } from "../extensions/extension-registry.js";
import { getProviderApiKey } from "./auth-store.js";
import { resolveProviderTransport } from "./provider-transport.js";

export async function listProviders(): Promise<ProviderDefinition[]> {
  const extensions = await listEnabledExtensions();
  const warnings: string[] = [];
  const providers = [...builtinProviders, ...providersFromExtensions(extensions)];
  const seen = new Set<string>();
  const unique = providers.filter((provider) => {
    if (seen.has(provider.id)) {
      warnings.push(`Duplicate provider skipped: ${provider.id}`);
      return false;
    }
    seen.add(provider.id);
    return true;
  });
  for (const provider of unique) resolveProviderTransport(provider);
  return Promise.all(unique.map(hydrateProviderModels));
}

export async function findProvider(id: string): Promise<ProviderDefinition | undefined> {
  const providers = await listProviders();
  return providers.find((provider) => provider.id === id);
}

async function hydrateProviderModels(provider: ProviderDefinition): Promise<ProviderDefinition> {
  if (provider.runtime !== "anthropic-messages" && provider.runtime !== "openai-chat-completions" && provider.runtime !== "openai-responses") return provider;
  const modelsUrl = providerModelsUrl(provider);
  if (!modelsUrl) return provider;
  const apiKey = await getProviderApiKey(provider);
  if (!apiKey) return provider;

  try {
    const scheme = provider.authScheme ?? (provider.runtime === "anthropic-messages" ? "bearer-and-anthropic-key" : "bearer");
    const response = await fetch(modelsUrl, {
      signal: AbortSignal.timeout(5_000),
      headers: {
        accept: "application/json",
        ...(scheme === "bearer" || scheme === "bearer-and-anthropic-key" ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(scheme === "anthropic-key" || scheme === "bearer-and-anthropic-key" ? { "x-api-key": apiKey } : {}),
        ...(provider.runtime === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}),
        ...(provider.headers ?? {})
      }
    });
    if (!response.ok) return provider;
    const models = parseProviderModels(await response.json());
    if (!models.length) return provider;
    return {
      ...provider,
      models,
      defaultModel: models.includes(provider.defaultModel ?? "") ? provider.defaultModel : models[0]
    };
  } catch {
    return provider;
  }
}

function providerModelsUrl(provider: ProviderDefinition): string | undefined {
  if (!provider.endpoint) return undefined;
  try {
    const url = new URL(provider.endpoint);
    url.pathname = url.pathname
      .replace(/\/messages\/?$/, "/models")
      .replace(/\/chat\/completions\/?$/, "/models")
      .replace(/\/responses\/?$/, "/models");
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseProviderModels(payload: unknown): string[] {
  if (Array.isArray(payload)) return uniqueStrings(payload.flatMap(modelIdFromValue));
  if (!payload || typeof payload !== "object") return [];
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.data)) return uniqueStrings(record.data.flatMap(modelIdFromValue));
  if (Array.isArray(record.models)) return uniqueStrings(record.models.flatMap(modelIdFromValue));
  return [];
}

function modelIdFromValue(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const id = record.id ?? record.name ?? record.model;
  return typeof id === "string" && id.trim() ? [id.trim()] : [];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
