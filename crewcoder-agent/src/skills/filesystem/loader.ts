import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getCrewCoderHome } from "../../core/crewcoder-home.js";

export interface FilesystemSkill {
  name: string;
  description: string;
  path: string;
  body: string;
}

/**
 * Resolve the directory that holds user-authored, on-demand skills.
 *
 * These are the "regular skills that all models use" — they are NOT auto-injected
 * into the system prompt. They are discovered and surfaced only when the user runs
 * the `/skills` command. They live under the CrewCoder home (default
 * `~/.crewcoder/skills/`, or `$CREWCODER_HOME/skills`), and the location can be
 * overridden directly with the CREWCODER_SKILLS_DIR environment variable.
 */
export function resolveSkillsDir(): string {
  const override = process.env.CREWCODER_SKILLS_DIR?.trim();
  if (override) return path.resolve(override);
  return path.join(getCrewCoderHome().root, "skills");
}

/**
 * User skill catalogs agents may read on demand. Bodies are never auto-injected;
 * the model has to open a SKILL.md itself. Writes stay blocked — these roots
 * are not session external directories.
 */
export function resolveSkillCatalogRoots(): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, ".agents", "skills"),
    resolveSkillsDir(),
    path.join(home, ".claude", "skills"),
    path.join(home, ".codex", "skills")
  ];
  const unique: string[] = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    if (!unique.includes(resolved)) unique.push(resolved);
  }
  return unique;
}

export function existingSkillCatalogRoots(): string[] {
  return resolveSkillCatalogRoots().filter((root) => {
    try {
      return fs.statSync(root).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Session grants plus on-disk skill catalogs, for nested-agent sandbox roots. */
export function mergeSkillCatalogDirectories(directories: readonly string[] | undefined): string[] {
  const merged: string[] = [];
  for (const directory of [...(directories ?? []), ...existingSkillCatalogRoots()]) {
    const resolved = path.resolve(directory);
    if (!merged.includes(resolved)) merged.push(resolved);
  }
  return merged;
}

interface ParsedSkillFile {
  name: string;
  description: string;
  body: string;
}

/**
 * Parse a SKILL.md file: a YAML-ish frontmatter block (`name`, `description`)
 * delimited by `---`, followed by the markdown body.
 */
export function parseSkillFile(raw: string, fallbackName: string): ParsedSkillFile {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) {
    return { name: fallbackName, description: "", body: normalized.trim() };
  }
  const [, frontmatter, body] = match;
  const fields = parseFrontmatter(frontmatter);
  return {
    name: fields.name?.trim() || fallbackName,
    description: fields.description?.trim() || "",
    body: body.trim()
  };
}

function parseFrontmatter(frontmatter: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
    fields[key] = value;
  }
  return fields;
}

/**
 * Load all on-demand skills from the skills directory. Each skill is a subdirectory
 * containing a SKILL.md file. Returns an empty list when the directory is absent so
 * callers never have to guard for a fresh install.
 */
export function loadFilesystemSkills(skillsDir: string = resolveSkillsDir()): FilesystemSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: FilesystemSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    let raw: string;
    try {
      raw = fs.readFileSync(skillFile, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillFile(raw, entry.name);
    skills.push({
      name: parsed.name,
      description: parsed.description,
      path: skillFile,
      body: parsed.body
    });
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function findFilesystemSkill(name: string, skillsDir?: string): FilesystemSkill | undefined {
  const target = name.trim().toLowerCase();
  return loadFilesystemSkills(skillsDir).find((skill) => skill.name.toLowerCase() === target);
}
