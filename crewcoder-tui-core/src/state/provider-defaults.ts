import type { ProviderRecord } from "../bridge/crewcoder-process.js";

/** Offline provider catalog for pickers when `crewcoder providers` is unavailable. */
export const builtinProviderDefaults: ProviderRecord[] = [
  {
    id: "codex-cli",
    title: "OpenAI Codex CLI",
    models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
    defaultModel: "gpt-6-luna",
    description: "- Your installed Codex CLI and its login. Run: codex login."
  },
  {
    id: "opencode",
    title: "OpenCode Zen",
    models: ["minimax-2.5", "minimax-m2.5", "qwen3-coder", "sonnet", "opus"],
    defaultModel: "minimax-2.5",
    description: "- OpenCode Zen. Set OPENCODE_API_KEY."
  },
  {
    id: "opencode-go",
    title: "OpenCode Zen Go",
    models: ["minimax-2.5", "minimax-m2.5", "qwen3-coder", "sonnet", "opus"],
    defaultModel: "minimax-2.5",
    description: "- OpenCode Go. Set OPENCODE_API_KEY."
  }
];

/** The discovered provider record, or the offline default when discovery returned no models. */
export function resolveProviderRecord(providerId: string, provider?: ProviderRecord): ProviderRecord {
  const fallback = builtinProviderDefaults.find((item) => item.id === providerId);
  if (!provider || provider.models.length === 0) {
    return fallback ?? { id: providerId, title: providerId, models: [], defaultModel: undefined };
  }
  return provider;
}
