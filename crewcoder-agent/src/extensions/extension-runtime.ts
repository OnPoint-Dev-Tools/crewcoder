import path from "node:path";
import { pathToFileURL } from "node:url";
import { readConfig } from "../core/config.js";
import type { AgentEvent } from "../core/events.js";
import { createGitWorkflowHelpers } from "../core/git-workflow.js";
import { createSessionCheckpoint, listSessionCheckpoints, previewSessionCheckpointRestore } from "../core/session-checkpoints.js";
import type { ExtensionUiBridge } from "../core/extension-ui-bridge.js";
import type { ToolCallPart, ToolResultMessage } from "../core/messages.js";
import type { ToolContext } from "../core/tool-types.js";
import { listEnabledExtensions } from "./extension-registry.js";
import type { LoadedCrewCoderExtension } from "./types.js";
import type { CrewCoderExtAgentEventOptions, CrewCoderExtAPI, CrewCoderExtCommandContext, CrewCoderExtContext, CrewCoderExtEventHandler, CrewCoderExtEventMap, CrewCoderExtEventName, CrewCoderExtEventResult, CrewCoderExtRegisteredCommand, CrewCoderExtSessionEntry, CrewCoderExtToolDefinition } from "./api.js";

type RegisteredExtensionEventHandler = (event: unknown, ctx: CrewCoderExtContext) => CrewCoderExtEventResult | Promise<CrewCoderExtEventResult>;

export type LoadedCrewCoderExtensionRuntime = {
  tools: Array<CrewCoderExtToolDefinition & { extensionId: string }>;
  commands: CrewCoderExtRegisteredCommand[];
  handlers: Map<CrewCoderExtEventName, Array<{ extensionId: string; handler: RegisteredExtensionEventHandler; eventTypes?: Array<AgentEvent["type"]> }>>;
  entries: CrewCoderExtSessionEntry[];
  warnings: string[];
};

function sessionEntryKey(entry: CrewCoderExtSessionEntry): string {
  return `${entry.extensionId}::${entry.timestamp}::${entry.customType}`;
}

/**
 * Idempotently replays prior session entries into the runtime so trusted
 * extensions can read their own history via `getSessionEntries()`. Dedupes by
 * extension id + timestamp + type so re-seeding the cached runtime (e.g. on a
 * second resume within the same process) never duplicates entries.
 */
export function seedCrewCoderExtensionEntries(runtime: LoadedCrewCoderExtensionRuntime, entries: CrewCoderExtSessionEntry[]): void {
  if (entries.length === 0) return;
  const known = new Set(runtime.entries.map(sessionEntryKey));
  for (const entry of entries) {
    const key = sessionEntryKey(entry);
    if (known.has(key)) continue;
    known.add(key);
    runtime.entries.push({ extensionId: entry.extensionId, customType: entry.customType, data: entry.data, timestamp: entry.timestamp });
  }
}

let cachedRuntime: Promise<LoadedCrewCoderExtensionRuntime> | undefined;

export function clearCrewCoderExtensionRuntimeCache(): void {
  cachedRuntime = undefined;
}

export async function loadTrustedCrewCoderExtensionRuntime(): Promise<LoadedCrewCoderExtensionRuntime> {
  cachedRuntime ??= loadRuntime();
  return cachedRuntime;
}

export async function emitCrewCoderExtensionEvent<K extends CrewCoderExtEventName>(
  runtime: LoadedCrewCoderExtensionRuntime,
  eventName: K,
  event: CrewCoderExtEventMap[K],
  context: Partial<CrewCoderExtContext> = {},
  uiBridge?: ExtensionUiBridge
): Promise<CrewCoderExtEventResult[]> {
  const handlers = runtime.handlers.get(eventName) ?? [];
  const results: CrewCoderExtEventResult[] = [];
  for (const item of handlers) {
    if (!shouldDeliverEvent(eventName, event, item.eventTypes)) continue;
    try {
      const ui = uiBridge ? uiBridge.uiFor(item.extensionId) : context.ui;
      const result = await item.handler(event, createContext({ ...context, ui, hasUI: uiBridge ? true : context.hasUI }));
      if (result) results.push(result);
    } catch (error) {
      runtime.warnings.push(`Extension ${item.extensionId} ${eventName} handler failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return results;
}

function shouldDeliverEvent<K extends CrewCoderExtEventName>(eventName: K, event: CrewCoderExtEventMap[K], eventTypes?: Array<AgentEvent["type"]>): boolean {
  if (eventName !== "agent_event" || !eventTypes?.length) return true;
  return eventTypes.includes((event as AgentEvent).type);
}

function normalizeAgentEventTypes(types: Array<AgentEvent["type"]> | undefined): Array<AgentEvent["type"]> | undefined {
  if (!types?.length) return undefined;
  return [...new Set(types.filter((type): type is AgentEvent["type"] => typeof type === "string" && type.length > 0))];
}

export function normalizeBeforeToolEventResults(results: CrewCoderExtEventResult[]): { action: "allow" | "block" | "modify"; reason?: string; args?: Record<string, unknown>; context?: string } {
  let args: Record<string, unknown> | undefined;
  const contexts: string[] = [];
  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    if (typeof result.context === "string" && result.context.trim()) contexts.push(result.context.trim());
    if ("block" in result && result.block === true) return { action: "block", reason: result.reason ?? "Blocked by CrewCoderExtAPI handler", context: contexts.join("\n") || undefined };
    if ("action" in result && result.action === "block") return { action: "block", reason: result.reason ?? "Blocked by CrewCoderExtAPI handler", context: contexts.join("\n") || undefined };
    if ("action" in result && result.action === "modify" && result.args && typeof result.args === "object" && !Array.isArray(result.args)) args = result.args;
  }
  if (args) return { action: "modify", args, context: contexts.join("\n") || undefined };
  return { action: "allow", context: contexts.join("\n") || undefined };
}

export function collectContextEventResults(results: CrewCoderExtEventResult[]): string[] {
  return results.flatMap((result) => result && typeof result === "object" && typeof result.context === "string" && result.context.trim() ? [result.context.trim()] : []);
}

function createApi(extensionId: string, runtime: LoadedCrewCoderExtensionRuntime): CrewCoderExtAPI {
  function handleEvent<K extends Exclude<CrewCoderExtEventName, "agent_event">>(event: K, handler: CrewCoderExtEventHandler<K>): void;
  function handleEvent(event: "agent_event", handler: CrewCoderExtEventHandler<"agent_event">): void;
  function handleEvent(event: "agent_event", options: CrewCoderExtAgentEventOptions, handler: CrewCoderExtEventHandler<"agent_event">): void;
  function handleEvent(event: CrewCoderExtEventName, optionsOrHandler: unknown, maybeHandler?: CrewCoderExtEventHandler<"agent_event">): void {
    const handler = typeof optionsOrHandler === "function" ? optionsOrHandler as CrewCoderExtEventHandler : maybeHandler;
    if (!handler) return;
    const handlers = runtime.handlers.get(event) ?? [];
    const options = typeof optionsOrHandler === "object" && optionsOrHandler !== null ? optionsOrHandler as CrewCoderExtAgentEventOptions : undefined;
    const eventTypes = event === "agent_event" ? normalizeAgentEventTypes(options?.types) : undefined;
    handlers.push({ extensionId, handler: handler as RegisteredExtensionEventHandler, eventTypes });
    runtime.handlers.set(event, handlers);
  }

  return {
    handleEvent,
    defineTool(definition) {
      runtime.tools.push({ ...definition, extensionId });
    },
    defineCommand(name, definition) {
      runtime.commands.push({ ...definition, name: normalizeCommandName(name), extensionId });
    },
    writeSessionEntry(customType, data) {
      runtime.entries.push({ extensionId, customType, data, timestamp: Date.now() });
    },
    getSessionEntries() {
      return runtime.entries.filter((entry) => entry.extensionId === extensionId);
    },
    getDefinedTools() {
      return runtime.tools.filter((tool) => tool.extensionId === extensionId);
    },
    getDefinedCommands() {
      return runtime.commands.filter((command) => command.extensionId === extensionId);
    }
  };
}

async function loadRuntime(): Promise<LoadedCrewCoderExtensionRuntime> {
  const runtime: LoadedCrewCoderExtensionRuntime = { tools: [], commands: [], handlers: new Map(), entries: [], warnings: [] };
  const config = readConfig();
  if (!config.allowExtensionModules) return runtime;
  const trusted = new Set(config.trustedExtensions);
  if (trusted.size === 0) return runtime;
  const extensions = await listEnabledExtensions();
  for (const extension of extensions.filter((item) => trusted.has(item.manifest.id))) {
    const main = extension.manifest.main;
    if (!main) continue;
    await loadExtensionModule(extension, main, runtime);
  }
  return runtime;
}

async function loadExtensionModule(extension: LoadedCrewCoderExtension, main: string, runtime: LoadedCrewCoderExtensionRuntime): Promise<void> {
  const resolved = path.resolve(extension.dir, main);
  if (resolved !== extension.dir && !resolved.startsWith(extension.dir + path.sep)) {
    runtime.warnings.push(`Extension ${extension.manifest.id} main is outside the extension directory.`);
    return;
  }
  try {
    const imported = await import(pathToFileURL(resolved).href);
    const factory = imported.default;
    if (typeof factory !== "function") {
      runtime.warnings.push(`Extension ${extension.manifest.id} main does not export a default function.`);
      return;
    }
    await factory(createApi(extension.manifest.id, runtime));
  } catch (error) {
    runtime.warnings.push(`Extension ${extension.manifest.id} failed to load main: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function createContext(input: Partial<CrewCoderExtContext> & { toolContext?: ToolContext } = {}): CrewCoderExtContext {
  const cwd = input.cwd ?? process.cwd();
  const sessionId = input.sessionId;
  const git = createGitWorkflowHelpers({ cwd, sessionId });
  return {
    cwd,
    sessionId,
    mode: input.mode ?? "print",
    hasUI: input.hasUI ?? false,
    signal: input.signal,
    ui: input.ui ?? {
      notify() {},
      async confirm() { return false; },
      async input(_title, options) { return options?.defaultValue; },
      async select<T extends string>(_title: string, options: T[] | Array<{ label: string; value: T; description?: string }>): Promise<T | undefined> {
        const first = options[0] as T | { value: T } | undefined;
        return typeof first === "string" ? first : first?.value;
      },
      async component(_title, component, options) {
        if (options?.actions?.length) return options.actions[0]?.id;
        if (component.kind === "actionList") return component.actions[0]?.id;
        return undefined;
      }
    },
    checkpoints: input.checkpoints ?? {
      async create(reason) {
        if (!sessionId) throw new Error("Cannot create checkpoint without an active session.");
        return createSessionCheckpoint({ sessionId, cwd, reason: reason.trim() || "Extension checkpoint" });
      },
      async list() {
        if (!sessionId) return [];
        return listSessionCheckpoints(sessionId);
      },
      async preview(checkpointId) {
        if (!sessionId) throw new Error("Cannot preview checkpoint without an active session.");
        return previewSessionCheckpointRestore(sessionId, checkpointId, { cwd });
      }
    },
    git: input.git ?? {
      status: git.status,
      currentBranch: git.currentBranch,
      changedFiles: git.changedFiles,
      createCheckpoint: git.createCheckpoint,
      issueReferences: git.issueReferences,
      reviewSummary: git.reviewSummary
    }
  };
}

export function createCommandContext(input: Partial<CrewCoderExtCommandContext>, runtime: LoadedCrewCoderExtensionRuntime, extensionId: string): CrewCoderExtCommandContext {
  return {
    ...createContext(input),
    writeSessionEntry(customType, data) {
      runtime.entries.push({ extensionId, customType, data, timestamp: Date.now() });
    },
    getSessionEntries() {
      return runtime.entries.filter((entry) => entry.extensionId === extensionId);
    }
  };
}

export function moduleToolName(extensionId: string, toolName: string): string {
  return `extension_${safeNamePart(extensionId)}_${safeNamePart(toolName)}`;
}

function normalizeCommandName(name: string): string {
  return name.replace(/^\/+/, "").trim();
}

function safeNamePart(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "extension";
}
