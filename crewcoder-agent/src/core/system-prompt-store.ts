import fs from "node:fs";
import path from "node:path";
import { ensureCrewCoderHome } from "./crewcoder-home.js";

const PROMPT_FILE = "SYSTEM-PROMPT.md";

export type StoredSystemPrompt = {
  name: string;
  dir: string;
  path: string;
  content: string;
};

export function resolveSystemPromptsDir(): string {
  return ensureCrewCoderHome().systemPromptsDir;
}

export function normalizeSystemPromptName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("System prompt name cannot be empty.");
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) throw new Error("System prompt names may only contain letters, numbers, dots, underscores, and dashes.");
  if (trimmed === "." || trimmed === "..") throw new Error("System prompt name cannot be . or ..");
  return trimmed;
}

export function getSystemPromptPath(name: string): string {
  const normalized = normalizeSystemPromptName(name);
  return path.join(resolveSystemPromptsDir(), normalized, PROMPT_FILE);
}

export function saveSystemPrompt(name: string, content: string): StoredSystemPrompt {
  const normalized = normalizeSystemPromptName(name);
  const dir = path.join(resolveSystemPromptsDir(), normalized);
  const file = path.join(dir, PROMPT_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  return { name: normalized, dir, path: file, content: fs.readFileSync(file, "utf8") };
}

export function getSystemPrompt(name: string): StoredSystemPrompt {
  const normalized = normalizeSystemPromptName(name);
  const file = getSystemPromptPath(normalized);
  if (!fs.existsSync(file)) throw new Error(`System prompt not found: ${normalized}`);
  return {
    name: normalized,
    dir: path.dirname(file),
    path: file,
    content: fs.readFileSync(file, "utf8")
  };
}

export function findSystemPrompt(name: string | undefined): StoredSystemPrompt | null {
  if (!name?.trim()) return null;
  try {
    return getSystemPrompt(name);
  } catch {
    return null;
  }
}

export function listSystemPrompts(): StoredSystemPrompt[] {
  const root = resolveSystemPromptsDir();
  fs.mkdirSync(root, { recursive: true });
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return fs.existsSync(getSystemPromptPath(name));
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b))
    .map((name) => getSystemPrompt(name));
}
