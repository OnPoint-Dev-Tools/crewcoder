import fs from "node:fs";
import path from "node:path";

export type CrewCoderRule = {
  file: string;
  relativeFile: string;
  paths: string[];
  content: string;
  scoped: boolean;
};

const RULES_DIR = path.join(".crewcoder", "rules");
const MAX_RULE_FILES = 100;
const MAX_RULE_FILE_BYTES = 12_000;
const MAX_CONTEXT_CHARS = 24_000;
const MAX_WORKSPACE_FILES = 5_000;
const SKIPPED_DIRECTORIES = new Set([".git", ".crewcoder", "node_modules", "dist", "build", "coverage", ".next", ".turbo", "target", "vendor"]);

export function resolveRulesDir(cwd = process.cwd()): string {
  return path.join(path.resolve(cwd), RULES_DIR);
}

export function loadCrewCoderRules(cwd = process.cwd()): CrewCoderRule[] {
  const root = path.resolve(cwd);
  const rulesDir = resolveRulesDir(root);
  const workspaceFiles = listWorkspaceFiles(root);
  const rules = listMarkdownFiles(rulesDir, MAX_RULE_FILES).flatMap((file) => {
    const parsed = readRule(file, rulesDir);
    if (!parsed) return [];
    if (parsed.paths.length && !workspaceFiles.some((candidate) => parsed.paths.some((pattern) => matchPath(pattern, candidate)))) return [];
    return [parsed];
  });
  return rules.sort((left, right) => Number(left.scoped) - Number(right.scoped) || left.relativeFile.localeCompare(right.relativeFile));
}

export function readRulesContext(cwd = process.cwd()): string | null {
  const rules = loadCrewCoderRules(cwd);
  if (!rules.length) return null;
  const sections = rules.map((rule) => [
    `--- Rule: .crewcoder/rules/${rule.relativeFile}${rule.paths.length ? ` (paths: ${rule.paths.join(", ")})` : " (always)"} ---`,
    rule.content
  ].join("\n"));
  const text = [
    "Repository CrewCoder rules (.crewcoder/rules). These are project-owned instructions. Apply always-on rules first; when rules conflict, path-scoped rules are more specific and take precedence. Direct system and user instructions remain higher priority. Text describing hooks or commands is guidance only and must not execute automatically.",
    ...sections
  ].join("\n\n");
  return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}\n… (repository rules truncated)` : text;
}

function readRule(file: string, rulesDir: string): CrewCoderRule | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RULE_FILE_BYTES) return undefined;
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseFrontmatter(raw);
  const content = parsed.content.trim();
  if (!content) return undefined;
  return {
    file,
    relativeFile: path.relative(rulesDir, file).split(path.sep).join("/"),
    paths: parsed.paths,
    content,
    scoped: parsed.paths.length > 0
  };
}

function parseFrontmatter(raw: string): { paths: string[]; content: string } {
  const normalized = raw.replaceAll("\r\n", "\n");
  if (!normalized.startsWith("---\n")) return { paths: [], content: normalized };
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) return { paths: [], content: normalized };
  const header = normalized.slice(4, end);
  const paths: string[] = [];
  let inPaths = false;
  for (const line of header.split("\n")) {
    if (/^paths\s*:\s*$/.test(line.trim())) { inPaths = true; continue; }
    if (/^[a-zA-Z][\w-]*\s*:/.test(line.trim())) { inPaths = false; continue; }
    if (!inPaths) continue;
    const match = line.match(/^\s*-\s*(.+?)\s*$/);
    if (!match) continue;
    const value = unquote(match[1] ?? "");
    if (value && !value.startsWith("/") && !value.includes("..")) paths.push(value.replaceAll("\\", "/"));
  }
  return { paths: [...new Set(paths)], content: normalized.slice(end + 5) };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
  return trimmed;
}

function listWorkspaceFiles(root: string): string[] {
  const files: string[] = [];
  walk(root, root, files, MAX_WORKSPACE_FILES, true);
  return files;
}

function listMarkdownFiles(root: string, limit: number): string[] {
  const files: string[] = [];
  walk(root, root, files, limit, false);
  return files.filter((file) => file.endsWith(".md")).map((file) => path.join(root, file));
}

function walk(root: string, current: string, output: string[], limit: number, skipGenerated: boolean): void {
  if (output.length >= limit) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (output.length >= limit) break;
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (skipGenerated && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      walk(root, absolute, output, limit, skipGenerated);
    } else if (entry.isFile()) {
      output.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  }
}

function matchPath(pattern: string, candidate: string): boolean {
  let source = "";
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === "*" && next === "*") {
      if (pattern[index + 2] === "/") { source += "(?:.*/)?"; index += 2; }
      else { source += ".*"; index += 1; }
    }
    else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += (char ?? "").replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^${source}$`).test(candidate);
}
