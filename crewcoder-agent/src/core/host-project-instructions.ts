import fs from "node:fs";
import path from "node:path";
import { isCodexCliProvider } from "../providers/codex-app-server-provider.js";
import type { ProviderDefinition } from "../providers/types.js";

/**
 * Project instruction files an embedding host (such as CrewMate) reads and sends
 * over ACP `session/set_project_instructions`. Some provider backends already
 * load these files from the session cwd on their own, so CrewCoder decides per
 * turn which host copies to keep. Only CrewCoder knows the active provider: it
 * can come from config, CREWCODER_PROVIDER, or a mid-session model switch.
 */
export type HostProjectInstruction = { file: HostProjectInstructionFile; text: string };
export type HostProjectInstructionFile = "AGENTS.md";

export const HOST_PROJECT_INSTRUCTION_FILES: readonly HostProjectInstructionFile[] = ["AGENTS.md"];
export const HOST_PROJECT_INSTRUCTIONS_MAX_CHARS = 131_072;

/** Advertised on `initialize._meta` so hosts send project files separately instead of inside the system prompt. */
export const CREWCODER_PROJECT_INSTRUCTIONS_META = {
  method: "session/set_project_instructions",
  version: 1,
  files: HOST_PROJECT_INSTRUCTION_FILES,
  maxChars: HOST_PROJECT_INSTRUCTIONS_MAX_CHARS,
  persisted: false
} as const;

export function parseHostProjectInstructions(value: unknown): HostProjectInstruction[] {
  if (!Array.isArray(value)) throw new Error("instructions must be an array (empty clears them)");
  const seen = new Set<string>();
  const parsed = value.map((entry) => {
    const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
    const file = record.file;
    if (typeof file !== "string" || !HOST_PROJECT_INSTRUCTION_FILES.includes(file as HostProjectInstructionFile)) {
      throw new Error(`file must be one of: ${HOST_PROJECT_INSTRUCTION_FILES.join(", ")}`);
    }
    if (seen.has(file)) throw new Error(`${file} was sent more than once`);
    seen.add(file);
    if (typeof record.text !== "string") throw new Error("text must be a string");
    return { file: file as HostProjectInstructionFile, text: record.text.trim() };
  }).filter((entry) => entry.text);
  const total = parsed.reduce((sum, entry) => sum + entry.text.length, 0);
  if (total > HOST_PROJECT_INSTRUCTIONS_MAX_CHARS) throw new Error(`instructions exceed ${HOST_PROJECT_INSTRUCTIONS_MAX_CHARS} characters`);
  return parsed;
}

// Claude Code imports another file with `@path`; `.claude/CLAUDE.md` reaches the root file as `@../AGENTS.md`.
const CLAUDE_AGENTS_IMPORT = /(^|\s)@(\.{1,2}\/)?AGENTS\.md\b/m;

function claudeImportsAgents(cwd: string): boolean {
  return [path.join(cwd, "CLAUDE.md"), path.join(cwd, ".claude", "CLAUDE.md")].some((file) => {
    try {
      return CLAUDE_AGENTS_IMPORT.test(fs.readFileSync(file, "utf8"));
    } catch {
      return false;
    }
  });
}

/**
 * Files the provider backend loads from `cwd` by itself:
 * - codex-cli runs the user's `codex app-server`, which always reads AGENTS.md.
 * - The Claude Agent SDK loads project CLAUDE.md (settingSources: ["project"]), which only
 *   brings AGENTS.md along when it imports it.
 * Every other runtime receives only what CrewCoder puts in its system field.
 */
export function nativelyLoadedInstructionFiles(provider: Pick<ProviderDefinition, "id" | "kind" | "runtime"> | undefined, cwd: string): Set<HostProjectInstructionFile> {
  if (!provider) return new Set();
  if (isCodexCliProvider(provider)) return new Set(["AGENTS.md"]);
  if (provider.runtime === "claude-agent-sdk" && claudeImportsAgents(cwd)) return new Set(["AGENTS.md"]);
  return new Set();
}

/** Host project files the active provider would not otherwise see, joined for the system field. */
export function selectHostProjectInstructions(instructions: readonly HostProjectInstruction[] | undefined, native: ReadonlySet<HostProjectInstructionFile>): string | undefined {
  const kept = (instructions ?? []).filter((entry) => !native.has(entry.file)).map((entry) => entry.text);
  return kept.length ? kept.join("\n\n") : undefined;
}
