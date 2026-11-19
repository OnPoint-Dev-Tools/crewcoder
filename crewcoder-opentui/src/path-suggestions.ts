import fs from "node:fs/promises";
import path from "node:path";

/**
 * `@` path suggestions in the composer, ported from the legacy
 * `crewcoder-tui/src/components/path-suggestions.ts`: the same walk, ignore
 * list, limits, and matching, plus the pure token and windowing helpers the
 * OpenTUI composer needs.
 */
export type PathSuggestion = {
  /** Workspace-relative, POSIX separators; directories end with `/`. */
  path: string;
  type: "file" | "directory";
};

/** Lists workspace paths for a query; injectable so tests never walk a real tree. */
export type PathLister = (cwd: string, query: string, limit: number) => Promise<PathSuggestion[]>;

/** The `@token` around the cursor: `[start, end)` in the composer text, query without `@`. */
export type MentionToken = { start: number; end: number; query: string };

/** Suggestions fetched per query, like the legacy UI. */
export const MENTION_LIMIT = 50;
/** List rows shown under the composer; longer lists scroll with the cursor. */
export const MENTION_ROWS = 8;

const IGNORED = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage", ".cache", ".crewcoder"]);
const MAX_VISITED = 1500;
const MAX_DEPTH = 7;

/**
 * The mention token the cursor is in, or undefined. A token starts after
 * whitespace (or at the start) with `@`, so `user@host` never triggers, and
 * holds only path characters.
 */
export function currentMention(text: string, cursor: number): MentionToken | undefined {
  const at = Math.max(0, Math.min(text.length, cursor));
  const before = text.slice(0, at);
  const start = Math.max(before.lastIndexOf(" "), before.lastIndexOf("\n"), before.lastIndexOf("\t")) + 1;
  if (text[start] !== "@") return undefined;
  const rest = text.slice(at).search(/\s/);
  const end = rest === -1 ? text.length : at + rest;
  const token = text.slice(start, end);
  if (!/^@[A-Za-z0-9._/\\-]*$/.test(token)) return undefined;
  return { start, end, query: token.slice(1) };
}

/**
 * The composer text with the token replaced by the picked path, and the cursor
 * after it. A file gets a trailing space (done); a directory (`src/`) does
 * not, so its contents are suggested next.
 */
export function replaceMention(text: string, token: MentionToken, pick: PathSuggestion): { text: string; cursor: number } {
  const replacement = pick.type === "directory" ? `@${pick.path}` : `@${pick.path} `;
  return { text: text.slice(0, token.start) + replacement + text.slice(token.end), cursor: token.start + replacement.length };
}

/** First row to draw so `cursor` stays visible in `rows` rows. */
export function mentionWindowStart(count: number, cursor: number, rows: number = MENTION_ROWS): number {
  if (count <= rows) return 0;
  return Math.min(Math.max(0, cursor - rows + 1), count - rows);
}

/** Rows the suggestion list takes under the composer (one for the empty note). */
export function mentionRows(count: number, rows: number = MENTION_ROWS): number {
  return Math.max(1, Math.min(count, rows));
}

/**
 * Up to `limit` workspace paths matching `query`, directories first at each
 * level, skipping build output and VCS folders. Stops after MAX_VISITED
 * entries or MAX_DEPTH levels so a huge tree never stalls typing. Unreadable
 * directories are skipped.
 */
export const listPathSuggestions: PathLister = async (cwd, query, limit) => {
  const wanted = normalizeQuery(query);
  const results: PathSuggestion[] = [];
  let visited = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (results.length >= limit || visited >= MAX_VISITED || depth > MAX_DEPTH) return;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (results.length >= limit || visited >= MAX_VISITED) return;
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(cwd, full).split(path.sep).join("/");
      visited += 1;
      if (entry.isDirectory()) {
        if (matchesQuery(relative, wanted)) results.push({ path: `${relative}/`, type: "directory" });
        await walk(full, depth + 1);
      } else if (entry.isFile() && matchesQuery(relative, wanted)) {
        results.push({ path: relative, type: "file" });
      }
    }
  }

  await walk(cwd, 0);
  return results.slice(0, limit);
};

function normalizeQuery(query: string): string {
  return query.replace(/^@/, "").replace(/^\.\//, "").toLowerCase();
}

/** Prefix of the path, of any path segment, or of the file name. */
function matchesQuery(relative: string, query: string): boolean {
  if (!query) return true;
  const lower = relative.toLowerCase();
  return lower.startsWith(query) || lower.includes(`/${query}`) || path.posix.basename(lower).startsWith(query);
}
