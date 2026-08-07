import fs from "node:fs";
import { ensureCrewCoderHome } from "./crewcoder-home.js";
import { isAgentMode, normalizeAgentMode, AGENT_MODE_LIST, DEFAULT_AGENT_MODE } from "./mode-router.js";
import { DEFAULT_STALL_CONFIG } from "./stall-detector.js";
import type { AgentMode } from "./types.js";
import { DEFAULT_INTEGRATION_PROFILE, isIntegrationProfile, type IntegrationProfile } from "./integration-profile.js";

export type GoalConfig = {
  /** Maximum detached supervisor cycles before pausing. */
  maxTurns: number;
  /** Optional independent verifier model on the same provider as the goal worker. */
  checkModel?: string;
  /** Wall-clock limit from initial goal start, including approval waits and resumes. */
  timeoutMinutes: number;
};

/** Per-model USD rates, in dollars per million tokens. */
export type ModelPriceEntry = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cacheReadPerMillionUsd?: number;
  cacheWritePerMillionUsd?: number;
};

export interface CrewCoderConfig {
  /** Optional CrewCode desktop compatibility bundle. Standalone is the fresh-install default. */
  integrationProfile: IntegrationProfile;
  defaultMode: AgentMode;
  defaultProvider: string;
  defaultModel?: string;
  /** Forward/request provider-supplied reasoning. When false, all providers receive effort none/off. */
  thinkingEnabled: boolean;
  /** Hard cap on model turns. 0 means unlimited (the default); stall detection is the real guard. */
  maxIterations: number;
  /** Stop a run once it is provably looping. On by default; this is the only always-on runaway guard. */
  stallDetection: boolean;
  /** Identical consecutive tool calls before a run is considered stalled. */
  stallRepeatThreshold: number;
  /** Consecutive failing tool calls before a run is considered stalled. */
  stallErrorThreshold: number;
  allowExtensionTools: boolean;
  allowExtensionHooks: boolean;
  allowExtensionModules: boolean;
  allowExtensionLiveUi: boolean;
  disabledExtensions: string[];
  trustedExtensions: string[];
  sandboxedExtensions: string[];
  /** Extra registry index URLs (or local paths) searched by `crewcoder extension search`. */
  extensionRegistries: string[];
  /**
   * Search the first-party CrewCoder registry in addition to `extensionRegistries`.
   * A flag rather than a seeded array entry, because config.json is written on first read:
   * a seeded default would only ever reach installs created after this build.
   */
  useDefaultExtensionRegistry: boolean;
  sandboxAllowedHosts: string[];
  sandboxNetworkIsolation: "proxy" | "strict";
  activeWorker: string;
  /** Create bounded filesystem snapshots before mutating tools. */
  checkpointsEnabled: boolean;
  autoCompact: boolean;
  autoCompactThresholdTokens: number;
  /** When true, live compaction pauses to preview (and allow editing) the summary before installing it. */
  compactionPreview: boolean;
  autoActivateExtensionSkills: boolean;
  /**
   * Cost-ledger rate overrides keyed by `provider:model` or bare `model`.
   * Takes precedence over the OpenRouter catalog so discounted, self-hosted, or
   * unlisted endpoints can be priced accurately.
   */
  modelPricing: Record<string, ModelPriceEntry>;
  goals: GoalConfig;
}

const MIN_COMPACT_THRESHOLD = 10_000;
const MAX_COMPACT_THRESHOLD = 2_000_000;
const DEFAULT_COMPACT_THRESHOLD = 150_000;
const MAX_ITERATION_CAP = 1_000;
const MIN_GOAL_TURNS = 1;
const MAX_GOAL_TURNS = 10_000;
const MIN_GOAL_TIMEOUT_MINUTES = 1;
const MAX_GOAL_TIMEOUT_MINUTES = 43_200;
const MIN_STALL_THRESHOLD = 2;
const MAX_STALL_THRESHOLD = 100;

const defaultConfig: CrewCoderConfig = {
  integrationProfile: DEFAULT_INTEGRATION_PROFILE,
  defaultMode: DEFAULT_AGENT_MODE,
  defaultProvider: "codex",
  defaultModel: "gpt-5.6-luna",
  thinkingEnabled: true,
  maxIterations: 0,
  stallDetection: true,
  stallRepeatThreshold: DEFAULT_STALL_CONFIG.repeatThreshold,
  stallErrorThreshold: DEFAULT_STALL_CONFIG.errorThreshold,
  allowExtensionTools: false,
  allowExtensionHooks: false,
  allowExtensionModules: false,
  allowExtensionLiveUi: false,
  disabledExtensions: [],
  trustedExtensions: [],
  sandboxedExtensions: [],
  extensionRegistries: [],
  useDefaultExtensionRegistry: true,
  sandboxAllowedHosts: [],
  sandboxNetworkIsolation: "proxy",
  activeWorker: "Crew",
  checkpointsEnabled: true,
  autoCompact: true,
  autoCompactThresholdTokens: DEFAULT_COMPACT_THRESHOLD,
  compactionPreview: false,
  autoActivateExtensionSkills: true,
  modelPricing: {},
  goals: { maxTurns: 200, timeoutMinutes: 480 }
};

export function readConfig(): CrewCoderConfig {
  const home = ensureCrewCoderHome();
  if (!fs.existsSync(home.configPath)) return writeConfig(defaultConfig);
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(home.configPath, "utf8")) as Partial<CrewCoderConfig>);
  } catch {
    return writeConfig(defaultConfig);
  }
}

export function writeConfig(config: CrewCoderConfig): CrewCoderConfig {
  const home = ensureCrewCoderHome();
  const normalized = normalizeConfig(config);
  fs.writeFileSync(home.configPath, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  return normalized;
}

export function setActiveWorkerName(name: string): CrewCoderConfig {
  const current = readConfig();
  const trimmed = name.trim();
  return writeConfig({ ...current, activeWorker: trimmed || current.activeWorker });
}

export type CrewCoderConfigSetKey = keyof CrewCoderConfig | "goals.maxTurns" | "goals.checkModel" | "goals.timeoutMinutes";

export function setConfigValue(key: CrewCoderConfigSetKey, value: string): CrewCoderConfig {
  const current = readConfig();
  const next: CrewCoderConfig = { ...current };
  if (key === "integrationProfile") {
    if (!isIntegrationProfile(value)) throw new Error("integrationProfile must be one of: standalone, crewcode");
    next.integrationProfile = value;
  } else if (key === "defaultMode") {
    if (!isAgentMode(value)) throw new Error(`defaultMode must be one of: ${AGENT_MODE_LIST}`);
    next.defaultMode = value;
  } else if (key === "defaultProvider") {
    if (!value.trim()) throw new Error("defaultProvider cannot be empty");
    next.defaultProvider = value.trim();
  } else if (key === "defaultModel") {
    next.defaultModel = value.trim() || undefined;
  } else if (key === "thinkingEnabled") {
    if (value !== "true" && value !== "false") throw new Error("thinkingEnabled must be true or false");
    next.thinkingEnabled = value === "true";
  } else if (key === "maxIterations") {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_ITERATION_CAP) throw new Error(`maxIterations must be an integer from 0 to ${MAX_ITERATION_CAP} (0 = unlimited)`);
    next.maxIterations = parsed;
  } else if (key === "stallDetection") {
    next.stallDetection = value === "true";
  } else if (key === "stallRepeatThreshold" || key === "stallErrorThreshold") {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_STALL_THRESHOLD || parsed > MAX_STALL_THRESHOLD) {
      throw new Error(`${key} must be an integer from ${MIN_STALL_THRESHOLD} to ${MAX_STALL_THRESHOLD}`);
    }
    next[key] = parsed;
  } else if (key === "allowExtensionTools") {
    next.allowExtensionTools = value === "true";
  } else if (key === "allowExtensionHooks") {
    next.allowExtensionHooks = value === "true";
  } else if (key === "allowExtensionModules") {
    next.allowExtensionModules = value === "true";
  } else if (key === "allowExtensionLiveUi") {
    next.allowExtensionLiveUi = value === "true";
  } else if (key === "checkpointsEnabled") {
    next.checkpointsEnabled = value === "true";
  } else if (key === "autoCompact") {
    next.autoCompact = value === "true";
  } else if (key === "compactionPreview") {
    next.compactionPreview = value === "true";
  } else if (key === "autoActivateExtensionSkills") {
    next.autoActivateExtensionSkills = value === "true";
  } else if (key === "autoCompactThresholdTokens") {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < MIN_COMPACT_THRESHOLD || parsed > MAX_COMPACT_THRESHOLD) {
      throw new Error(`autoCompactThresholdTokens must be an integer from ${MIN_COMPACT_THRESHOLD} to ${MAX_COMPACT_THRESHOLD}`);
    }
    next.autoCompactThresholdTokens = parsed;
  } else if (key === "disabledExtensions") {
    next.disabledExtensions = value.split(",").map((item) => item.trim()).filter(Boolean);
  } else if (key === "trustedExtensions") {
    next.trustedExtensions = value.split(",").map((item) => item.trim()).filter(Boolean);
  } else if (key === "sandboxedExtensions") {
    next.sandboxedExtensions = value.split(",").map((item) => item.trim()).filter(Boolean);
  } else if (key === "useDefaultExtensionRegistry") {
    next.useDefaultExtensionRegistry = value === "true";
  } else if (key === "extensionRegistries") {
    next.extensionRegistries = value.split(",").map((item) => item.trim()).filter(Boolean);
  } else if (key === "sandboxAllowedHosts") {
    next.sandboxAllowedHosts = value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  } else if (key === "sandboxNetworkIsolation") {
    if (value !== "proxy" && value !== "strict") throw new Error("sandboxNetworkIsolation must be one of: proxy, strict");
    next.sandboxNetworkIsolation = value;
  } else if (key === "goals.maxTurns") {
    next.goals = { ...next.goals, maxTurns: integerInRange(value, key, MIN_GOAL_TURNS, MAX_GOAL_TURNS) };
  } else if (key === "goals.checkModel") {
    next.goals = { ...next.goals, checkModel: value.trim() || undefined };
  } else if (key === "goals.timeoutMinutes") {
    next.goals = { ...next.goals, timeoutMinutes: integerInRange(value, key, MIN_GOAL_TIMEOUT_MINUTES, MAX_GOAL_TIMEOUT_MINUTES) };
  } else {
    throw new Error(`Unsupported config key: ${String(key)}`);
  }
  return writeConfig(next);
}

function integerInRange(value: string, key: string, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`${key} must be an integer from ${minimum} to ${maximum}`);
  return parsed;
}

function normalizeModelPricing(input: unknown): Record<string, ModelPriceEntry> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const entries: Array<[string, ModelPriceEntry]> = [];
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const trimmedKey = key.trim();
    const entry = normalizeModelPriceEntry(value);
    if (trimmedKey && entry) entries.push([trimmedKey, entry]);
  }
  return Object.fromEntries(entries);
}

function normalizeModelPriceEntry(value: unknown): ModelPriceEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const inputPerMillionUsd = usdRate(record.inputPerMillionUsd);
  const outputPerMillionUsd = usdRate(record.outputPerMillionUsd);
  if (inputPerMillionUsd === undefined || outputPerMillionUsd === undefined) return undefined;
  const cacheReadPerMillionUsd = usdRate(record.cacheReadPerMillionUsd);
  const cacheWritePerMillionUsd = usdRate(record.cacheWritePerMillionUsd);
  return {
    inputPerMillionUsd,
    outputPerMillionUsd,
    ...(cacheReadPerMillionUsd === undefined ? {} : { cacheReadPerMillionUsd }),
    ...(cacheWritePerMillionUsd === undefined ? {} : { cacheWritePerMillionUsd })
  };
}

function usdRate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function clampStallThreshold(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, MIN_STALL_THRESHOLD), MAX_STALL_THRESHOLD);
}

function normalizeConfig(input: Partial<CrewCoderConfig>): CrewCoderConfig {
  return {
    integrationProfile: isIntegrationProfile(input.integrationProfile) ? input.integrationProfile : DEFAULT_INTEGRATION_PROFILE,
    defaultMode: normalizeAgentMode(input.defaultMode),
    defaultProvider: typeof input.defaultProvider === "string" && input.defaultProvider.trim() ? input.defaultProvider.trim() : defaultConfig.defaultProvider,
    defaultModel: typeof input.defaultModel === "string" && input.defaultModel.trim() ? input.defaultModel.trim() : undefined,
    thinkingEnabled: input.thinkingEnabled !== false,
    maxIterations: typeof input.maxIterations === "number" && Number.isInteger(input.maxIterations) ? Math.min(Math.max(input.maxIterations, 0), MAX_ITERATION_CAP) : defaultConfig.maxIterations,
    stallDetection: input.stallDetection !== false,
    stallRepeatThreshold: clampStallThreshold(input.stallRepeatThreshold, defaultConfig.stallRepeatThreshold),
    stallErrorThreshold: clampStallThreshold(input.stallErrorThreshold, defaultConfig.stallErrorThreshold),
    allowExtensionTools: input.allowExtensionTools === true,
    allowExtensionHooks: input.allowExtensionHooks === true,
    allowExtensionModules: input.allowExtensionModules === true,
    allowExtensionLiveUi: input.allowExtensionLiveUi === true,
    disabledExtensions: Array.isArray(input.disabledExtensions) ? input.disabledExtensions.filter((item): item is string => typeof item === "string") : [],
    trustedExtensions: Array.isArray(input.trustedExtensions) ? input.trustedExtensions.filter((item): item is string => typeof item === "string") : [],
    sandboxedExtensions: Array.isArray(input.sandboxedExtensions) ? input.sandboxedExtensions.filter((item): item is string => typeof item === "string") : [],
    extensionRegistries: Array.isArray(input.extensionRegistries) ? input.extensionRegistries.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [],
    useDefaultExtensionRegistry: input.useDefaultExtensionRegistry !== false,
    sandboxAllowedHosts: Array.isArray(input.sandboxAllowedHosts) ? input.sandboxAllowedHosts.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean) : [],
    sandboxNetworkIsolation: input.sandboxNetworkIsolation === "strict" ? "strict" : "proxy",
    activeWorker: typeof input.activeWorker === "string" && input.activeWorker.trim() ? input.activeWorker.trim() : defaultConfig.activeWorker,
    checkpointsEnabled: input.checkpointsEnabled !== false,
    autoCompact: input.autoCompact !== false,
    autoCompactThresholdTokens: typeof input.autoCompactThresholdTokens === "number" && Number.isInteger(input.autoCompactThresholdTokens)
      ? Math.min(Math.max(input.autoCompactThresholdTokens, MIN_COMPACT_THRESHOLD), MAX_COMPACT_THRESHOLD)
      : defaultConfig.autoCompactThresholdTokens,
    compactionPreview: input.compactionPreview === true,
    autoActivateExtensionSkills: input.autoActivateExtensionSkills !== false,
    modelPricing: normalizeModelPricing(input.modelPricing),
    goals: {
      maxTurns: typeof input.goals?.maxTurns === "number" && Number.isInteger(input.goals.maxTurns)
        ? Math.min(Math.max(input.goals.maxTurns, MIN_GOAL_TURNS), MAX_GOAL_TURNS)
        : defaultConfig.goals.maxTurns,
      ...(typeof input.goals?.checkModel === "string" && input.goals.checkModel.trim() ? { checkModel: input.goals.checkModel.trim() } : {}),
      timeoutMinutes: typeof input.goals?.timeoutMinutes === "number" && Number.isInteger(input.goals.timeoutMinutes)
        ? Math.min(Math.max(input.goals.timeoutMinutes, MIN_GOAL_TIMEOUT_MINUTES), MAX_GOAL_TIMEOUT_MINUTES)
        : defaultConfig.goals.timeoutMinutes
    }
  };
}
