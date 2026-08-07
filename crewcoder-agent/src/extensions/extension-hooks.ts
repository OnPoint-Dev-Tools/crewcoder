import { spawn } from "node:child_process";
import { readConfig } from "../core/config.js";
import type { ToolCallPart, ToolResultMessage } from "../core/messages.js";
import type { ToolContext } from "../core/tool-types.js";
import { listEnabledExtensions } from "./extension-registry.js";
import { matchesToolCall, type ToolCallMatchers } from "./tool-call-matcher.js";
import type { CrewCoderExtensionHookEvent, LoadedCrewCoderExtension } from "./types.js";

type ExtensionHookEvent = CrewCoderExtensionHookEvent;

type ExtensionHookManifest = {
  id: string;
  title: string;
  description?: string;
  event?: ExtensionHookEvent;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  matches?: ToolCallMatchers;
};

export type LoadedExtensionHook = {
  extensionId: string;
  hookId: string;
  title: string;
  event: ExtensionHookEvent;
  command: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
  /** Declarative tool-call filter. Empty means the hook fires for every tool call. */
  matches: ToolCallMatchers;
};

export type BeforeToolHookDecision =
  | { action: "allow"; context?: string }
  | { action: "block"; reason: string; context?: string }
  | { action: "modify"; args: Record<string, unknown>; context?: string };

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

export async function loadTrustedExtensionHooks(): Promise<LoadedExtensionHook[]> {
  const config = readConfig();
  if (!config.allowExtensionHooks) return [];
  const trusted = new Set(config.trustedExtensions);
  if (trusted.size === 0) return [];
  const extensions = await listEnabledExtensions();
  return extensions
    .filter((extension) => trusted.has(extension.manifest.id))
    .flatMap(extensionHooksFromManifest);
}

export function extensionHooksFromManifest(extension: LoadedCrewCoderExtension): LoadedExtensionHook[] {
  return (extension.manifest.contributes?.hooks ?? [])
    .filter((hook): hook is ExtensionHookManifest => isExecutableHook(hook))
    .map((hook) => ({
      extensionId: extension.manifest.id,
      hookId: hook.id,
      title: hook.title,
      event: hook.event ?? "context",
      command: hook.command as string,
      args: hook.args ?? [],
      env: hook.env ?? {},
      timeoutMs: clampTimeout(hook.timeoutMs),
      matches: hook.matches ?? {}
    }));
}

export async function collectExtensionContext(hooks: LoadedExtensionHook[], input: { cwd: string; sessionId: string; prompt: string; mode: string }): Promise<string[]> {
  const contexts: string[] = [];
  for (const hook of hooks.filter((item) => item.event === "context")) {
    const result = await runHookJson(hook, input);
    const context = stringField(result, "context") ?? stringField(result, "text");
    if (context?.trim()) contexts.push(`[${hook.extensionId}/${hook.hookId}]\n${context.trim()}`);
  }
  return contexts;
}

/** Hooks subscribed to `event` whose declarative `matches` filter accepts this tool call. */
function hooksFor(hooks: LoadedExtensionHook[], event: ExtensionHookEvent, toolCall: ToolCallPart): LoadedExtensionHook[] {
  return hooks.filter((hook) => hook.event === event && matchesToolCall(hook.matches, toolCall));
}

export async function runBeforeToolHooks(hooks: LoadedExtensionHook[], toolCall: ToolCallPart, context: ToolContext): Promise<BeforeToolHookDecision> {
  let args = toolCall.arguments;
  const notes: string[] = [];
  for (const hook of hooksFor(hooks, "beforeToolCall", toolCall)) {
    const result = await runHookJson(hook, { toolCall: { ...toolCall, arguments: args }, context });
    const action = stringField(result, "action");
    const note = stringField(result, "context");
    if (note) notes.push(`[${hook.extensionId}/${hook.hookId}] ${note}`);
    if (action === "block") return { action: "block", reason: stringField(result, "reason") ?? `Blocked by extension hook ${hook.extensionId}/${hook.hookId}`, context: notes.join("\n") || undefined };
    if (action === "modify") {
      const nextArgs = result.args;
      if (nextArgs && typeof nextArgs === "object" && !Array.isArray(nextArgs)) args = nextArgs as Record<string, unknown>;
    }
  }
  if (args !== toolCall.arguments) return { action: "modify", args, context: notes.join("\n") || undefined };
  return { action: "allow", context: notes.join("\n") || undefined };
}

export async function runAfterToolHooks(hooks: LoadedExtensionHook[], toolCall: ToolCallPart, result: ToolResultMessage, context: ToolContext): Promise<string[]> {
  const notes: string[] = [];
  for (const hook of hooksFor(hooks, "afterToolCall", toolCall)) {
    const output = await runHookJson(hook, { toolCall, result, context });
    const note = stringField(output, "context") ?? stringField(output, "text");
    if (note?.trim()) notes.push(`[${hook.extensionId}/${hook.hookId}] ${note.trim()}`);
  }
  return notes;
}

export type CompactionHookInput = {
  /** The proposed summary, before it is installed. */
  summary: string;
  source: "model" | "deterministic";
  /** Why the LLM summarizer was skipped, when `source` is `deterministic`. */
  fallbackReason?: string;
  originalMessageCount: number;
  retainedMessageCount: number;
  cwd: string;
  sessionId: string;
};

export type CompactionHookResult = {
  /** The summary after every hook has had a turn. */
  summary: string;
  /** Advisory notes surfaced as backend_debug events. */
  notes: string[];
};

/**
 * Runs on a prepared-but-not-yet-installed compaction proposal, so an extension can rewrite or
 * extend the summary before older messages are discarded.
 *
 * Hooks chain: each one sees the previous hook's summary. `append` exists because the common
 * case is "make sure these facts survive compaction", and forcing an extension to reproduce the
 * entire summary just to add a line would be a footgun.
 *
 * This runs BEFORE the human preview, so `/compact preview` shows the hook-adjusted text and a
 * human edit still gets the last word.
 */
export async function runCompactionHooks(hooks: LoadedExtensionHook[], input: CompactionHookInput): Promise<CompactionHookResult> {
  let summary = input.summary;
  const notes: string[] = [];
  for (const hook of hooks.filter((item) => item.event === "compaction")) {
    const output = await runHookJson(hook, { ...input, summary });
    const replacement = stringField(output, "summary");
    const append = stringField(output, "append");
    const note = stringField(output, "context");
    if (replacement?.trim()) summary = replacement.trim();
    if (append?.trim()) summary = `${summary}\n${append.trim()}`;
    if (note?.trim()) notes.push(`[${hook.extensionId}/${hook.hookId}] ${note.trim()}`);
  }
  return { summary, notes };
}

/**
 * Runs after a tool call that failed. Separate from `afterToolCall` so an extension can
 * subscribe to failures alone without inspecting every successful result.
 */
export async function runErrorHooks(hooks: LoadedExtensionHook[], toolCall: ToolCallPart, result: ToolResultMessage, context: ToolContext): Promise<string[]> {
  const notes: string[] = [];
  const error = result.content.map((part) => part.text).join("\n");
  for (const hook of hooksFor(hooks, "onError", toolCall)) {
    const output = await runHookJson(hook, { toolCall, result, error, context });
    const note = stringField(output, "context") ?? stringField(output, "text");
    if (note?.trim()) notes.push(`[${hook.extensionId}/${hook.hookId}] ${note.trim()}`);
  }
  return notes;
}

function isExecutableHook(value: unknown): value is ExtensionHookManifest {
  if (!value || typeof value !== "object") return false;
  const hook = value as ExtensionHookManifest;
  return typeof hook.id === "string" && typeof hook.title === "string" && typeof hook.command === "string" && hook.command.trim().length > 0;
}

function clampTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), 1_000), MAX_TIMEOUT_MS);
}

async function runHookJson(hook: LoadedExtensionHook, payload: unknown): Promise<Record<string, unknown>> {
  const output = await runHookCommand(hook, payload);
  if (!output.trim()) return {};
  try {
    const parsed = JSON.parse(output) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { text: output };
  } catch {
    return { text: output };
  }
}

function runHookCommand(hook: LoadedExtensionHook, payload: unknown): Promise<string> {
  return new Promise((resolve) => {
    const payloadJson = JSON.stringify(payload);
    const child = spawn(hook.command, hook.args.map((arg) => renderTemplate(arg, payloadJson)), {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...renderEnv(hook.env, payloadJson) }
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), hook.timeoutMs);
    child.stdin.end(payloadJson);
    child.stdout.on("data", (chunk) => { output += chunk.toString(); if (output.length > 120_000) output = output.slice(-120_000); });
    child.stderr.on("data", (chunk) => { output += chunk.toString(); if (output.length > 120_000) output = output.slice(-120_000); });
    child.on("error", (error) => { output += `\n${error.message}`; });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(output.trim());
    });
  });
}

function renderTemplate(template: string, payloadJson: string): string {
  return template.replaceAll("{{json}}", payloadJson).replaceAll("{{payloadJson}}", payloadJson);
}

function renderEnv(env: Record<string, string>, payloadJson: string): Record<string, string> {
  const rendered: Record<string, string> = { CREWCODER_EXTENSION_HOOK_PAYLOAD: payloadJson };
  for (const [key, value] of Object.entries(env)) rendered[key] = renderTemplate(value, payloadJson);
  return rendered;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}
