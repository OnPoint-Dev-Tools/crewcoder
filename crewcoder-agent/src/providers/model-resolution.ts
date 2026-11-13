import type { ProviderDefinition } from "./types.js";

export function resolveProviderModel(provider: ProviderDefinition, requested?: string): string | undefined {
  const normalized = requested?.trim();
  if (normalized && normalized !== "default") return normalized;
  return provider.defaultModel;
}

export function listProviderModelIds(provider: ProviderDefinition): string[] {
  // An explicit empty catalog means discovery found no selectable models.
  if (provider.modelCatalog) return provider.modelCatalog.map((model) => model.id);
  if (provider.models) return provider.models;
  return provider.defaultModel ? [provider.defaultModel] : ["default"];
}

export function supportsParallelToolCalls(provider: ProviderDefinition, model: string | undefined): boolean {
  const modelCapability = provider.modelCatalog?.find((item) => item.id === model)?.parallelToolCalls;
  return modelCapability ?? provider.capabilities?.parallelToolCalls ?? false;
}
