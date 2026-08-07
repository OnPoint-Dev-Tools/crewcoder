import type { AgentMode, ResolvedAgentMode } from "./types.js";

export const AGENT_MODES: readonly AgentMode[] = ["general", "plugin", "extension"];

export const DEFAULT_AGENT_MODE: AgentMode = "general";

/** Human-readable list used in CLI help and validation errors. */
export const AGENT_MODE_LIST = AGENT_MODES.join(", ");

/**
 * Legacy persisted mode values coerced on read.
 *
 * `auto` was removed along with keyword routing, but it is still sitting in existing
 * `config.json` files, saved session records, and goal records. Coercing it here keeps
 * that state loadable instead of throwing on the user's history.
 */
const LEGACY_MODE_ALIASES: Record<string, AgentMode> = {
  auto: DEFAULT_AGENT_MODE
};

export function isAgentMode(value: string): value is AgentMode {
  return value === "general" || value === "plugin" || value === "extension";
}

/** Coerce arbitrary/persisted input to a valid mode, falling back to the default. */
export function normalizeAgentMode(value: unknown): AgentMode {
  if (typeof value !== "string") return DEFAULT_AGENT_MODE;
  const lower = value.trim().toLowerCase();
  if (isAgentMode(lower)) return lower;
  return LEGACY_MODE_ALIASES[lower] ?? DEFAULT_AGENT_MODE;
}

/**
 * The requested mode is the resolved mode.
 *
 * This is intentionally identity + legacy coercion. Prompt keyword routing was removed
 * with `auto`: guessing a mode from prompt text silently changed which constraints were
 * treated as law, which is worse than making the user say what they want.
 */
export function resolveMode(requestedMode: AgentMode): ResolvedAgentMode {
  return normalizeAgentMode(requestedMode);
}
