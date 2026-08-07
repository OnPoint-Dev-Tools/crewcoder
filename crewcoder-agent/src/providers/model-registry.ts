import { builtinProviders } from "./builtins.js";
import { listProviders } from "./provider-registry.js";
import { getProviderApiKey } from "./auth-store.js";
import { listProviderModelIds, resolveProviderModel } from "./model-resolution.js";
import { resolveOpenRouterContextWindow } from "./openrouter-model-catalog.js";
import type { ProviderDefinition, ProviderModel } from "./types.js";

export type CrewCoderResolvedModel = {
  provider: ProviderDefinition;
  model: string;
  metadata?: ProviderModel;
  hasAuth: boolean;
};

export async function resolveModel(providerId: string, requested?: string): Promise<CrewCoderResolvedModel | undefined> {
  const provider = (await listProviders()).find((item) => item.id === providerId);
  if (!provider) return undefined;
  const model = resolveProviderModel(provider, requested) ?? listProviderModelIds(provider)[0];
  if (!model) return undefined;
  const declaredMetadata = provider.modelCatalog?.find((item) => item.id === model);
  const contextWindow = declaredMetadata?.contextWindow ?? await resolveOpenRouterContextWindow(model);
  const metadata = declaredMetadata
    ? { ...declaredMetadata, contextWindow }
    : contextWindow === undefined ? undefined : { id: model, contextWindow };
  return { provider, model, metadata, hasAuth: await hasProviderAuth(provider) };
}

export async function hasProviderAuth(provider: ProviderDefinition): Promise<boolean> {
  if (provider.runtime === "process" || provider.runtime === "model-command") return true;
  return Boolean(await getProviderApiKey(provider));
}

export function listBuiltinProviderModels(): Array<{ provider: string; models: string[]; defaultModel?: string }> {
  return builtinProviders.map((provider) => ({ provider: provider.id, models: listProviderModelIds(provider), defaultModel: provider.defaultModel }));
}
