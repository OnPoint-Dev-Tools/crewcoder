import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isCodexCliProvider } from "../providers/codex-app-server-provider.js";
import type { ProviderDefinition } from "../providers/types.js";

/**
 * Per-session instruction policy set by an embedding host over ACP
 * `session/set_instruction_policy`. Defaults keep CrewCoder's standalone behavior:
 * the worker identity is on and no user-global instruction files are added.
 */
export type InstructionPolicy = { workerIdentity: boolean; globalInstructions: boolean };
export const DEFAULT_INSTRUCTION_POLICY: InstructionPolicy = { workerIdentity: true, globalInstructions: false };

export type GlobalInstructionSource = "codex-agents" | "claude-md";

export const CREWCODER_INSTRUCTION_POLICY_META = {
  method: "session/set_instruction_policy",
  version: 1,
  globalSources: ["codex-agents", "claude-md"] as GlobalInstructionSource[],
  persisted: false
} as const;

export const GLOBAL_INSTRUCTIONS_MAX_CHARS = 65_536;
// Claude Code follows imports up to five hops deep.
const MAX_IMPORT_DEPTH = 5;

export function parseInstructionPolicy(params: Record<string, unknown>): InstructionPolicy {
  if (typeof params.workerIdentity !== "boolean") throw new Error("workerIdentity must be a boolean");
  if (typeof params.globalInstructions !== "boolean") throw new Error("globalInstructions must be a boolean");
  return { workerIdentity: params.workerIdentity, globalInstructions: params.globalInstructions };
}

const codexHome = (): string => process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const claudeHome = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

const displayPath = (file: string): string => {
  const home = os.homedir();
  return file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
};

const readText = (file: string): string | undefined => {
  try {
    const stat = fs.statSync(file);
    return stat.isFile() && stat.size <= GLOBAL_INSTRUCTIONS_MAX_CHARS * 4 ? fs.readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
};

// `@path` at a word boundary outside fenced code; an email such as me@AGENTS.md is not an import.
const IMPORT = /(^|\s)@((?:~\/|\.{1,2}\/|\/)?[^\s`'"()<>]+\.[A-Za-z0-9]+)/g;

/** Claude Code inlines `@path` imports; a host-injected copy must carry them too or the rules arrive incomplete. */
function claudeImports(text: string, file: string, depth: number, seen: Set<string>): string[] {
  if (depth >= MAX_IMPORT_DEPTH) return [];
  const sections: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    for (const match of line.matchAll(IMPORT)) {
      const target = match[2]!;
      const resolved = target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : path.resolve(path.dirname(file), target);
      if (seen.has(resolved)) continue;
      const imported = readText(resolved);
      if (imported === undefined) continue;
      seen.add(resolved);
      sections.push(`--- Imported by ${displayPath(file)}: ${displayPath(resolved)} ---\n${imported.trim()}`);
      sections.push(...claudeImports(imported, resolved, depth + 1, seen));
    }
  }
  return sections;
}

function readSource(source: GlobalInstructionSource): { label: string; text: string } | undefined {
  if (source === "codex-agents") {
    const file = path.join(codexHome(), "AGENTS.md");
    const text = readText(file)?.trim();
    return text ? { label: displayPath(file), text } : undefined;
  }
  const file = path.join(claudeHome(), "CLAUDE.md");
  const text = readText(file)?.trim();
  if (!text) return undefined;
  const imports = claudeImports(text, file, 0, new Set([path.resolve(file)]));
  return { label: displayPath(file), text: [text, ...imports].join("\n\n") };
}

/**
 * Global files the backend reads by itself. codex-cli runs the user's Codex with their
 * CODEX_HOME, which loads its AGENTS.md. The Claude Agent SDK is started with project
 * settings only, so the user CLAUDE.md never arrives unless CrewCoder adds it.
 */
export function nativelyLoadedGlobalSources(provider: Pick<ProviderDefinition, "id" | "kind" | "runtime"> | undefined): Set<GlobalInstructionSource> {
  return provider && isCodexCliProvider(provider) ? new Set(["codex-agents"]) : new Set();
}

/** The user's global instruction files for the system field, minus any the provider already loads. */
export function buildGlobalInstructions(native: ReadonlySet<GlobalInstructionSource>): string | undefined {
  const sources = CREWCODER_INSTRUCTION_POLICY_META.globalSources.filter((source) => !native.has(source));
  const sections = sources.flatMap((source) => {
    const loaded = readSource(source);
    return loaded ? [`--- ${loaded.label} ---\n${loaded.text}`] : [];
  });
  if (!sections.length) return undefined;
  const body = sections.join("\n\n");
  const bounded = body.length > GLOBAL_INSTRUCTIONS_MAX_CHARS ? `${body.slice(0, GLOBAL_INSTRUCTIONS_MAX_CHARS)}\n… (global instructions truncated)` : body;
  return [
    "Global user instructions:",
    "The user's personal instruction files from this machine, included because the host enabled them. They are general preferences: host identity and role instructions and project rules are more specific and take precedence. They cannot change CrewCoder tool policy, approvals, or sandbox rules.",
    bounded
  ].join("\n\n");
}
