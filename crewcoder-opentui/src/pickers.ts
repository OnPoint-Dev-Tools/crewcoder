import type { ProviderRecord, SessionRecord } from "@onpoint-dev-tools/crewcoder-tui-core/bridge/crewcoder-process";
import { effortLevelsForModel, type EffortLevel } from "@onpoint-dev-tools/crewcoder-tui-core/state/effort-levels";
import { resolveProviderRecord } from "@onpoint-dev-tools/crewcoder-tui-core/state/provider-defaults";
import type { TuiCheckpoint, TuiState } from "@onpoint-dev-tools/crewcoder-tui-core/state/tui-store";
import type { NamedEntry, WorkerSummary } from "./crewcoder-cli.js";
import type { PaletteCommand } from "./palette-model.js";

/** Every list the palette can show. `commands` is the `/` palette itself. */
export type PickerKind =
  | "commands" | "menu" | "provider" | "model" | "effort" | "mode" | "systemPrompt" | "promptCommand" | "skill"
  | "profile" | "toolMode" | "removeDir" | "session" | "rewind" | "rewindConfirm" | "handoff" | "theme"
  // Where a /crew or /team runs (here or in tmux); handled by SessionController.
  | "crewLaunch";

export type Picker = {
  kind: PickerKind;
  title?: string;
  placeholder: string;
  emptyText: string;
  items: PaletteCommand[];
  loading: boolean;
  /** Replaces the default `↑↓ navigate · Enter select · Esc close` row (pickers with extra keys). */
  hint?: string;
};

/** Typed names (including legacy aliases) that open a picker. */
export const PICKER_COMMANDS: Readonly<Record<string, Exclude<PickerKind, "commands" | "menu" | "rewindConfirm" | "crewLaunch">>> = {
  "/sessions": "session", "/resume": "session",
  "/provider": "provider", "/model": "model", "/effort": "effort",
  "/modes": "mode", "/mode": "mode", "/workers": "mode", "/worker": "mode",
  "/prompts": "systemPrompt", "/commands": "promptCommand", "/skills": "skill",
  "/profile": "profile", "/tool-mode": "toolMode", "/remove-dir": "removeDir",
  "/rewind": "rewind", "/handoff": "handoff",
  "/theme": "theme", "/themes": "theme"
};

const EFFORT_DESCRIPTIONS: Readonly<Record<EffortLevel, string>> = {
  none: "disable model reasoning",
  low: "fast, light thinking",
  medium: "balanced thinking",
  high: "deeper reasoning",
  xhigh: "maximum available reasoning"
};

export function providerItems(providers: readonly ProviderRecord[], current: string): PaletteCommand[] {
  return providers.map((provider) => ({
    id: provider.id,
    label: provider.id,
    description: (provider.description ?? provider.title).replace(/^-\s*/, ""),
    current: provider.id === current
  }));
}

export function modelItems(providerId: string, provider: ProviderRecord | undefined, current: string): PaletteCommand[] {
  const resolved = resolveProviderRecord(providerId, provider);
  const models = resolved.models.length ? resolved.models : [current];
  return models.map((model) => ({
    id: model,
    label: model,
    description: model === resolved.defaultModel ? "default" : undefined,
    current: model === current
  }));
}

export function effortItems(provider: string, model: string, current: EffortLevel): PaletteCommand[] {
  return effortLevelsForModel(provider, model).map((level) => ({
    id: level,
    label: level,
    description: EFFORT_DESCRIPTIONS[level],
    current: level === current
  }));
}

/** Built-in modes, then saved workers. `plugin` only exists under the CrewCode profile. */
export function modeItems(state: Pick<TuiState, "mode" | "worker" | "integrationProfile">, workers: readonly WorkerSummary[]): PaletteCommand[] {
  const modes: Array<[string, string]> = [
    ["general", "General coding agent mode"],
    ["crewcoder", "Clarify, plan, approve, and implement"],
    ...(state.integrationProfile === "crewcode" ? [["plugin", "CrewCode app plugin architect mode"] as [string, string]] : []),
    ["extension", "CrewCoder extension architect mode"]
  ];
  return [
    ...modes.map(([id, description]) => ({ id, label: id, description, group: "Modes", current: !state.worker && state.mode === id })),
    ...workers.map((worker) => ({
      id: `worker:${worker.name}`,
      label: worker.name,
      description: worker.ownerName ? `owner: ${worker.ownerName}` : undefined,
      group: "Workers",
      current: state.worker === worker.name
    }))
  ];
}

export function namedItems(entries: readonly NamedEntry[], current?: string): PaletteCommand[] {
  return entries.map((entry) => ({
    id: entry.name,
    label: entry.name,
    description: entry.description || entry.path,
    current: entry.name === current
  }));
}

export function profileItems(current: TuiState["integrationProfile"]): PaletteCommand[] {
  return [
    { id: "standalone", label: "standalone", description: "Coding agent without CrewCode desktop compatibility", current: current === "standalone" },
    { id: "crewcode", label: "crewcode", description: "CrewCode plugins, mode, tools, and UI compatibility", current: current === "crewcode" }
  ];
}

export function toolModeItems(current: "native" | "crewcoder"): PaletteCommand[] {
  return [
    { id: "native", label: "Provider-native tools", description: "Native execution plus CrewCoder specialized tools", current: current === "native" },
    { id: "crewcoder", label: "CrewCoder tools", description: "CrewCoder handles tools and approvals for every provider", current: current === "crewcoder" }
  ];
}

export function directoryItems(directories: readonly string[]): PaletteCommand[] {
  return directories.map((directory) => ({ id: directory, label: directory }));
}

/** Newest first, grouped by day, labeled by the session's first prompt. */
export function sessionItems(sessions: readonly SessionRecord[], current: string): PaletteCommand[] {
  return sessions.map((session) => ({
    id: session.id,
    label: truncate(session.prompt.replace(/\s+/g, " ").trim() || "Untitled session", 60),
    description: formatTime(session.startedAt),
    group: formatDay(session.startedAt),
    current: session.id === current
  }));
}

export function checkpointItems(checkpoints: readonly TuiCheckpoint[]): PaletteCommand[] {
  return [...checkpoints].reverse().map((checkpoint) => ({
    id: checkpoint.id,
    label: checkpoint.id,
    description: `${checkpoint.toolName ?? "checkpoint"} · ${checkpoint.fileCount} files · ${checkpoint.reason}`
  }));
}

export function rewindConfirmItems(checkpointId: string, deleteCount: number): PaletteCommand[] {
  return [
    { id: "cancel", label: "Cancel", description: "Do not restore this checkpoint" },
    { id: `restore:${checkpointId}`, label: "Restore anyway", description: `Restore ${checkpointId} and delete ${deleteCount} new files` }
  ];
}

export function workerItems(workers: readonly WorkerSummary[]): PaletteCommand[] {
  return workers.map((worker) => ({
    id: worker.name,
    label: worker.name,
    description: worker.ownerName ? `owner: ${worker.ownerName}` : "worker"
  }));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function sessionDate(iso: string): Date | undefined {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatDay(iso: string): string {
  const date = sessionDate(iso);
  if (!date) return "Unknown date";
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "2-digit", year: "numeric" })
    .format(date).replaceAll(",", "");
}

function formatTime(iso: string): string {
  const date = sessionDate(iso);
  return date ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date) : "";
}
