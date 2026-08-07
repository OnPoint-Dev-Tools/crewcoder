import fs from "node:fs";
import path from "node:path";
import { ensureCrewCoderHome } from "./crewcoder-home.js";

const COMMAND_FILE = "COMMAND.md";

export type StoredPromptCommand = {
  name: string;
  path: string;
  content: string;
};

export function resolvePromptCommandsDir(): string {
  return ensureCrewCoderHome().commandsDir;
}

export function normalizePromptCommandName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Command name cannot be empty.");
  if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) throw new Error("Command names may only contain letters, numbers, dots, underscores, and dashes.");
  if (trimmed === "." || trimmed === "..") throw new Error("Command name cannot be . or ..");
  return trimmed;
}

export function savePromptCommand(name: string, content: string): StoredPromptCommand {
  const normalized = normalizePromptCommandName(name);
  const file = path.join(resolvePromptCommandsDir(), `${normalized}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  return getPromptCommand(normalized);
}

export function getPromptCommand(name: string): StoredPromptCommand {
  const normalized = normalizePromptCommandName(name);
  const file = resolvePromptCommandPath(normalized);
  if (!file) throw new Error(`Command not found: ${normalized}`);
  return {
    name: normalized,
    path: file,
    content: fs.readFileSync(file, "utf8")
  };
}

export function listPromptCommands(): StoredPromptCommand[] {
  const root = resolvePromptCommandsDir();
  fs.mkdirSync(root, { recursive: true });
  return fs.readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const file = commandFileForEntry(root, entry);
      if (!file) return [];
      const name = commandNameForEntry(entry);
      try {
        return [{ name, path: file, content: fs.readFileSync(file, "utf8") }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function resolvePromptCommandPath(name: string): string | undefined {
  const root = resolvePromptCommandsDir();
  const flat = path.join(root, `${name}.md`);
  if (fs.existsSync(flat)) return flat;
  const nested = path.join(root, name, COMMAND_FILE);
  if (fs.existsSync(nested)) return nested;
  return undefined;
}

function commandFileForEntry(root: string, entry: fs.Dirent): string | undefined {
  if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) return path.join(root, entry.name);
  if (!entry.isDirectory()) return undefined;
  const nested = path.join(root, entry.name, COMMAND_FILE);
  return fs.existsSync(nested) ? nested : undefined;
}

function commandNameForEntry(entry: fs.Dirent): string {
  return entry.isFile() && entry.name.toLowerCase().endsWith(".md")
    ? entry.name.slice(0, -3)
    : entry.name;
}
