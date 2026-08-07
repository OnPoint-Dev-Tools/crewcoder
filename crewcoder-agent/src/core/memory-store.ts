import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export type MemoryEntry = {
  id: string;
  topic: string;
  text: string;
  createdAt?: string;
  file: string;
};

const MEMORY_ROOT_DIRNAME = ".crewcoder";
const MEMORY_SUBDIR = "memory";
const MEMORY_SETTINGS_FILE = "memory-settings.json";
const MAX_CONTEXT_CHARS = 4000;
const ENTRY_LINE = /^-\s+(.*?)\s*(?:<!--\s*id:(\S+)\s+ts:(\S+)\s*-->)?\s*$/;

export function resolveMemoryDir(cwd = process.cwd()): string {
  return path.join(path.resolve(cwd), MEMORY_ROOT_DIRNAME, MEMORY_SUBDIR);
}

export function resolveMemorySettingsPath(cwd = process.cwd()): string {
  return path.join(path.resolve(cwd), MEMORY_ROOT_DIRNAME, MEMORY_SETTINGS_FILE);
}

export function isProjectMemoryEnabled(cwd = process.cwd()): boolean {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveMemorySettingsPath(cwd), "utf8")) as { enabled?: unknown };
    return parsed.enabled === true;
  } catch {
    return false;
  }
}

export function setProjectMemoryEnabled(cwd: string, enabled: boolean): string {
  const file = resolveMemorySettingsPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ enabled }, null, 2)}\n`, "utf8");
  return file;
}

export function sanitizeTopic(topic: string): string {
  const cleaned = topic.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "memory";
}

function memoryFilePath(cwd: string, topic: string): string {
  return path.join(resolveMemoryDir(cwd), `${sanitizeTopic(topic)}.md`);
}

function createMemoryId(): string {
  return crypto.randomBytes(4).toString("hex");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatEntryLine(entry: MemoryEntry): string {
  return `- ${entry.text} <!-- id:${entry.id} ts:${entry.createdAt} -->`;
}

function parseEntryLine(raw: string, topic: string, file: string): MemoryEntry | null {
  if (!raw.trim() || raw.trimStart().startsWith("#")) return null;
  const match = ENTRY_LINE.exec(raw);
  if (!match) return null;
  const text = normalizeText(match[1] ?? "");
  if (!text) return null;
  const id = match[2] ?? crypto.createHash("sha1").update(`${file}:${text}`).digest("hex").slice(0, 8);
  return { id, topic, text, createdAt: match[3], file };
}

export function rememberFact(cwd: string, text: string, options: { topic?: string } = {}): MemoryEntry {
  if (!isProjectMemoryEnabled(cwd)) throw new Error("Project memory is off. Enable it with: crewcoder memory on");
  const normalized = normalizeText(text);
  if (!normalized) throw new Error("Cannot remember an empty note.");
  const topic = sanitizeTopic(options.topic ?? "memory");
  const dir = resolveMemoryDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const file = memoryFilePath(cwd, topic);
  const entry: MemoryEntry = { id: createMemoryId(), topic, text: normalized, createdAt: new Date().toISOString(), file };
  const header = fs.existsSync(file) ? "" : `# CrewCoder Memory: ${topic}\n\n`;
  fs.appendFileSync(file, `${header}${formatEntryLine(entry)}\n`, "utf8");
  return entry;
}

export function listMemories(cwd = process.cwd()): MemoryEntry[] {
  const dir = resolveMemoryDir(cwd);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
  const entries: MemoryEntry[] = [];
  for (const fileName of files.sort()) {
    const file = path.join(dir, fileName);
    const topic = fileName.replace(/\.md$/, "");
    const content = fs.readFileSync(file, "utf8");
    for (const raw of content.split(/\r?\n/)) {
      const parsed = parseEntryLine(raw, topic, file);
      if (parsed) entries.push(parsed);
    }
  }
  return entries;
}

export function forgetMemory(cwd: string, id: string): MemoryEntry | null {
  const dir = resolveMemoryDir(cwd);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".md"));
  } catch {
    return null;
  }
  for (const fileName of files.sort()) {
    const file = path.join(dir, fileName);
    const topic = fileName.replace(/\.md$/, "");
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    let removed: MemoryEntry | null = null;
    const kept = lines.filter((raw) => {
      const parsed = parseEntryLine(raw, topic, file);
      if (parsed && parsed.id === id) {
        removed = parsed;
        return false;
      }
      return true;
    });
    if (removed) {
      fs.writeFileSync(file, `${kept.join("\n").replace(/\n+$/, "")}\n`, "utf8");
      return removed;
    }
  }
  return null;
}

export function readMemoryContext(cwd = process.cwd()): string | null {
  if (!isProjectMemoryEnabled(cwd)) return null;
  const entries = listMemories(cwd);
  if (!entries.length) return null;
  const byTopic = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const list = byTopic.get(entry.topic) ?? [];
    list.push(entry);
    byTopic.set(entry.topic, list);
  }
  const lines: string[] = ["Persistent cross-session memory for this repo (.crewcoder/memory). Treat these as durable user-provided facts to honor across sessions:"];
  for (const [topic, list] of byTopic) {
    lines.push(`- ${topic}:`);
    for (const entry of list) lines.push(`  - ${entry.text}`);
  }
  const text = lines.join("\n");
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n… (memory truncated)` : text;
}
