export type EffortLevel = "none" | "low" | "medium" | "high" | "xhigh";

export const DEFAULT_EFFORT: EffortLevel = "low";

export function effortLevelsForModel(provider: string, model?: string): EffortLevel[] {
  const providerId = provider.toLowerCase();
  const modelId = (model ?? "").toLowerCase();

  if (providerId === "codex") {
    // ChatGPT Codex Responses models reject "minimal"; the API advertises these values.
    return ["none", "low", "medium", "high", "xhigh"];
  }

  if (providerId.includes("openai") || modelId.startsWith("gpt-5")) {
    return ["none", "low", "medium", "high", "xhigh"];
  }

  if (providerId.includes("opencode") || modelId.includes("sonnet") || modelId.includes("opus")) {
    return ["none", "low", "medium", "high"];
  }

  return ["none", "low", "medium", "high"];
}

export function normalizeEffort(value: string | undefined, levels: EffortLevel[]): EffortLevel | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "off") return levels.includes("none") ? "none" : undefined;
  if (normalized === "minimal") return levels.includes("low") ? "low" : levels[0];
  return levels.includes(normalized as EffortLevel) ? normalized as EffortLevel : undefined;
}
