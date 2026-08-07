import { spawn } from "node:child_process";
import path from "node:path";
import { readConfig } from "../core/config.js";
import { listEnabledExtensions } from "./extension-registry.js";
import type { CrewCoderExtensionFileTriggerContribution, LoadedCrewCoderExtension } from "./types.js";

export type LoadedExtensionFileTrigger = {
  extensionId: string;
  triggerId: string;
  title: string;
  patterns: string[];
  command: string;
  args: string[];
  env: Record<string, string>;
  timeoutMs: number;
};

export type FileTriggerPayload = {
  path: string;
  toolName: string;
  cwd: string;
  sessionId: string;
};

export type FileTriggerRunResult = {
  trigger: LoadedExtensionFileTrigger;
  matched: boolean;
  output?: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;

export async function loadTrustedExtensionFileTriggers(): Promise<LoadedExtensionFileTrigger[]> {
  const config = readConfig();
  if (!config.allowExtensionHooks) return [];
  const trusted = new Set(config.trustedExtensions);
  if (trusted.size === 0) return [];
  const extensions = await listEnabledExtensions();
  return extensions
    .filter((extension) => trusted.has(extension.manifest.id))
    .flatMap(extensionFileTriggersFromManifest);
}

export function extensionFileTriggersFromManifest(extension: LoadedCrewCoderExtension): LoadedExtensionFileTrigger[] {
  return (extension.manifest.contributes?.fileTriggers ?? []).flatMap((trigger) => {
    if (!isFileTrigger(trigger)) return [];
    return [{
      extensionId: extension.manifest.id,
      triggerId: trigger.id,
      title: trigger.title,
      patterns: trigger.patterns,
      command: trigger.command,
      args: trigger.args ?? [],
      env: trigger.env ?? {},
      timeoutMs: clampTimeout(trigger.timeoutMs)
    }];
  });
}

export async function runExtensionFileTriggers(triggers: LoadedExtensionFileTrigger[], payload: FileTriggerPayload): Promise<FileTriggerRunResult[]> {
  const results: FileTriggerRunResult[] = [];
  for (const trigger of triggers) {
    const matched = trigger.patterns.some((pattern) => matchPath(pattern, payload.path));
    if (!matched) {
      results.push({ trigger, matched: false });
      continue;
    }
    const output = await runTriggerCommand(trigger, payload);
    results.push({ trigger, matched: true, output });
  }
  return results;
}

function isFileTrigger(value: unknown): value is CrewCoderExtensionFileTriggerContribution {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.title === "string" && Array.isArray(record.patterns) && typeof record.command === "string";
}

function clampTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), 1_000), MAX_TIMEOUT_MS);
}

function runTriggerCommand(trigger: LoadedExtensionFileTrigger, payload: FileTriggerPayload): Promise<string> {
  return new Promise((resolve) => {
    const payloadJson = JSON.stringify(payload);
    const child = spawn(trigger.command, trigger.args.map((arg) => renderTemplate(arg, payload, payloadJson)), {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: payload.cwd,
      env: { ...process.env, ...renderEnv(trigger.env, payload, payloadJson) }
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), trigger.timeoutMs);
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

function renderEnv(env: Record<string, string>, payload: FileTriggerPayload, payloadJson: string): Record<string, string> {
  const rendered: Record<string, string> = { CREWCODER_EXTENSION_FILE_TRIGGER_PAYLOAD: payloadJson };
  for (const [key, value] of Object.entries(env)) rendered[key] = renderTemplate(value, payload, payloadJson);
  return rendered;
}

function renderTemplate(template: string, payload: FileTriggerPayload, payloadJson: string): string {
  return template
    .replaceAll("{{json}}", payloadJson)
    .replaceAll("{{payloadJson}}", payloadJson)
    .replaceAll("{{path}}", payload.path)
    .replaceAll("{{toolName}}", payload.toolName)
    .replaceAll("{{cwd}}", payload.cwd)
    .replaceAll("{{sessionId}}", payload.sessionId);
}

function matchPath(pattern: string, candidate: string): boolean {
  const normalizedPattern = normalizePath(pattern);
  const normalizedCandidate = normalizePath(candidate);
  return globToRegExp(normalizedPattern).test(normalizedCandidate);
}

function normalizePath(value: string): string {
  return path.posix.normalize(value.replaceAll(path.sep, "/")).replace(/^\.\//, "");
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += ".";
    } else {
      source += escapeRegExp(char ?? "");
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
