import fs from "node:fs/promises";
import path from "node:path";

export type PathSuggestion = {
  path: string;
  type: "file" | "directory";
};

const ignored = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage", ".cache", ".crewcoder"]);
const MAX_VISITED = 1500;

export async function listPathSuggestions(cwd: string, query: string, limit = 60): Promise<PathSuggestion[]> {
  const normalizedQuery = normalizeQuery(query);
  const results: PathSuggestion[] = [];
  let visited = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (results.length >= limit || visited >= MAX_VISITED || depth > 7) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (results.length >= limit || visited >= MAX_VISITED) return;
      if (ignored.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relative = toPosix(path.relative(cwd, full));
      visited++;

      if (entry.isDirectory()) {
        if (matchesQuery(relative, normalizedQuery)) results.push({ path: `${relative}/`, type: "directory" });
        await walk(full, depth + 1);
        continue;
      }

      if (entry.isFile() && matchesQuery(relative, normalizedQuery)) results.push({ path: relative, type: "file" });
    }
  }

  await walk(cwd, 0);
  return results.slice(0, limit);
}

function normalizeQuery(query: string): string {
  return query.replace(/^@/, "").replace(/^\.\//, "").toLowerCase();
}

function matchesQuery(relative: string, query: string): boolean {
  if (!query) return true;
  const lower = relative.toLowerCase();
  return lower.startsWith(query) || lower.includes(`/${query}`) || path.basename(lower).startsWith(query);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}
