import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { resolveInsideCwd, relativeToCwd } from "./path-utils.js";
import { truncateToolOutputHead } from "./tool-output-limits.js";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 2_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_COUNT = 200;

type BlameArgs = { path: string; startLine?: number; endLine?: number; revision?: string };
type LogArgs = { maxCount: number; revision?: string; path?: string };
type DiffArgs = { from: string; to: string; path?: string; contextLines: number };
type CherryPickArgs = { commit: string };
type GitResult = { stdout: string; stderr: string };

export const gitBlameTool: ToolDefinition<BlameArgs> = {
  name: "git_blame",
  description: "Return structured line attribution for a tracked file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      startLine: { type: "integer", minimum: 1, description: "Optional first line (1-indexed)." },
      endLine: { type: "integer", minimum: 1, description: "Optional last line (inclusive)." },
      revision: { type: "string", description: "Optional commit or revision to inspect; defaults to the working tree." }
    },
    required: ["path"],
    additionalProperties: false
  },
  parse(args) {
    return { path: String(args.path ?? ""), startLine: positiveInteger(args.startLine), endLine: positiveInteger(args.endLine), revision: optionalString(args.revision) };
  },
  async execute(args, context) {
    const file = workspacePath(context.cwd, args.path);
    if (args.startLine && args.endLine && args.endLine < args.startLine) throw new Error("endLine must be greater than or equal to startLine");
    const command = ["blame", "--line-porcelain"];
    if (args.startLine || args.endLine) command.push("-L", `${args.startLine ?? 1},${args.endLine ?? args.startLine ?? 1}`);
    if (args.revision) command.push(assertRevision(args.revision));
    command.push("--", file);
    const result = await runGit(context.cwd, command);
    const lines = parseBlame(result.stdout);
    return boundedGitResult(lines.map((line) => `${line.line}: ${line.author} ${line.commit.slice(0, 10)} | ${line.text}`).join("\n") || "(no blame lines)", { path: file, revision: args.revision, lines });
  }
};

export const gitLogTool: ToolDefinition<LogArgs> = {
  name: "git_log",
  description: "Return structured commit history with hashes, authors, dates, subjects, and bodies.",
  parameters: {
    type: "object",
    properties: {
      maxCount: { type: "integer", minimum: 1, maximum: MAX_COUNT, description: "Maximum commits to return (default 20)." },
      revision: { type: "string", description: "Optional revision, branch, or range." },
      path: { type: "string", description: "Optional workspace-relative path filter." }
    },
    additionalProperties: false
  },
  parse(args) {
    return { maxCount: Math.min(MAX_COUNT, positiveInteger(args.maxCount) ?? 20), revision: optionalString(args.revision), path: optionalString(args.path) };
  },
  async execute(args, context) {
    const command = ["log", `--max-count=${args.maxCount}`, "--date=iso-strict", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1e"];
    if (args.revision) command.push(assertRevision(args.revision));
    const file = args.path ? workspacePath(context.cwd, args.path) : undefined;
    if (file) command.push("--", file);
    const result = await runGit(context.cwd, command);
    const commits = parseLog(result.stdout);
    return textResult(commits.map((commit) => `${commit.shortHash} ${commit.date} ${commit.author.name} | ${commit.subject}`).join("\n") || "(no commits)", { revision: args.revision, path: file, commits });
  }
};

export const gitDiffRangeTool: ToolDefinition<DiffArgs> = {
  name: "git_diff_range",
  description: "Return a structured file summary and unified patch between two Git revisions.",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "Base revision." },
      to: { type: "string", description: "Target revision." },
      path: { type: "string", description: "Optional workspace-relative path filter." },
      contextLines: { type: "integer", minimum: 0, maximum: 20, description: "Unified diff context lines (default 3)." }
    },
    required: ["from", "to"],
    additionalProperties: false
  },
  parse(args) {
    const contextLines = typeof args.contextLines === "number" && Number.isInteger(args.contextLines) ? Math.min(20, Math.max(0, args.contextLines)) : 3;
    return { from: String(args.from ?? ""), to: String(args.to ?? ""), path: optionalString(args.path), contextLines };
  },
  async execute(args, context) {
    const range = `${assertRevision(args.from)}..${assertRevision(args.to)}`;
    const file = args.path ? workspacePath(context.cwd, args.path) : undefined;
    const pathArgs = file ? ["--", file] : [];
    const [summaryResult, patchResult] = await Promise.all([
      runGit(context.cwd, ["diff", "--numstat", range, ...pathArgs]),
      runGit(context.cwd, ["diff", `--unified=${args.contextLines}`, "--no-ext-diff", range, ...pathArgs])
    ]);
    const files = parseNumstat(summaryResult.stdout);
    const patch = patchResult.stdout.trim() || "(no differences)";
    const truncation = truncateToolOutputHead(patch);
    const notice = truncation.truncated ? "\n\n[Git patch truncated at 2,000 lines or 50KB; narrow the path or revision range.]" : "";
    return textResult(`${truncation.text}${notice}`, { from: args.from, to: args.to, path: file, files, patch: truncation.text, truncated: truncation.truncated, totalPatchBytes: truncation.totalBytes });
  }
};

export const gitCherryPickTool: ToolDefinition<CherryPickArgs> = {
  name: "git_cherry_pick",
  description: "Cherry-pick one commit into the current branch. Requires a clean worktree and aborts automatically on failure.",
  parameters: {
    type: "object",
    properties: { commit: { type: "string", description: "Commit hash or revision to cherry-pick." } },
    required: ["commit"],
    additionalProperties: false
  },
  executionMode: "sequential",
  isMutation: true,
  parse(args) { return { commit: String(args.commit ?? "") }; },
  async execute(args, context) {
    const commit = assertRevision(args.commit);
    const beforeStatus = await runGit(context.cwd, ["status", "--porcelain"]);
    if (beforeStatus.stdout.trim()) throw new Error("git_cherry_pick requires a clean worktree");
    const resolved = (await runGit(context.cwd, ["rev-parse", "--verify", `${commit}^{commit}`])).stdout.trim();
    try {
      await runGit(context.cwd, ["cherry-pick", "--", resolved], 120_000);
    } catch (error) {
      await runGit(context.cwd, ["cherry-pick", "--abort"]).catch(() => undefined);
      throw new Error(`Cherry-pick failed and was aborted: ${error instanceof Error ? error.message : String(error)}`);
    }
    const [show, changed] = await Promise.all([
      runGit(context.cwd, ["show", "-s", "--date=iso-strict", "--format=%H%x1f%an%x1f%ae%x1f%aI%x1f%s", "HEAD"]),
      runGit(context.cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
    ]);
    const [hash = "", authorName = "", authorEmail = "", date = "", subject = ""] = show.stdout.trim().split("\x1f");
    const changedFiles = changed.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    for (const changedFile of changedFiles) context.mutationLog.push(changedFile);
    return textResult(`Cherry-picked ${hash.slice(0, 10)} ${subject}\n${changedFiles.join("\n")}`, { sourceCommit: resolved, commit: { hash, shortHash: hash.slice(0, 10), author: { name: authorName, email: authorEmail }, date, subject }, changedFiles });
  }
};

function boundedGitResult(text: string, details: Record<string, unknown>) {
  const truncation = truncateToolOutputHead(text);
  const notice = truncation.truncated ? "\n\n[Git output truncated at 2,000 lines or 50KB; narrow the request.]" : "";
  return textResult(`${truncation.text}${notice}`, { ...details, truncated: truncation.truncated, totalOutputBytes: truncation.totalBytes });
}

function workspacePath(cwd: string, userPath: string): string {
  return relativeToCwd(cwd, resolveInsideCwd(cwd, userPath));
}

function assertRevision(value: string): string {
  const revision = value.trim();
  if (!revision) throw new Error("Git revision is required");
  if (revision.startsWith("-") || /[\x00-\x20~^:?*[\\]/.test(revision)) throw new Error(`Invalid Git revision: ${value}`);
  return revision;
}

async function runGit(cwd: string, args: string[], timeout = DEFAULT_TIMEOUT_MS): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", args, { cwd, timeout, maxBuffer: MAX_BUFFER, encoding: "utf8" });
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const detail = failure.stderr?.trim() || failure.stdout?.trim() || failure.message;
    throw new Error(`git ${args[0] ?? "command"} failed: ${detail}`);
  }
}

function parseBlame(raw: string): Array<{ line: number; commit: string; author: string; authorEmail: string; authorTime: string; summary: string; text: string }> {
  const result: Array<{ line: number; commit: string; author: string; authorEmail: string; authorTime: string; summary: string; text: string }> = [];
  let current: { line: number; commit: string; author: string; authorEmail: string; authorTime: string; summary: string } | undefined;
  for (const line of raw.split(/\r?\n/)) {
    const header = line.match(/^([0-9a-f^]{40,41}) \d+ (\d+)(?: \d+)?$/);
    if (header) current = { line: Number(header[2]), commit: (header[1] ?? "").replace(/^\^/, ""), author: "Unknown", authorEmail: "", authorTime: "", summary: "" };
    else if (current && line.startsWith("author ")) current.author = line.slice(7);
    else if (current && line.startsWith("author-mail ")) current.authorEmail = line.slice(12).replace(/^<|>$/g, "");
    else if (current && line.startsWith("author-time ")) current.authorTime = new Date(Number(line.slice(12)) * 1000).toISOString();
    else if (current && line.startsWith("summary ")) current.summary = line.slice(8);
    else if (current && line.startsWith("\t")) { result.push({ ...current, text: line.slice(1) }); current = undefined; }
  }
  return result;
}

function parseLog(raw: string): Array<{ hash: string; shortHash: string; parents: string[]; author: { name: string; email: string }; date: string; subject: string; body: string }> {
  return raw.split("\x1e").flatMap((record) => {
    const trimmed = record.trim();
    if (!trimmed) return [];
    const [hash = "", parents = "", name = "", email = "", date = "", subject = "", ...body] = trimmed.split("\x1f");
    return [{ hash, shortHash: hash.slice(0, 10), parents: parents.split(" ").filter(Boolean), author: { name, email }, date, subject, body: body.join("\x1f").trim() }];
  });
}

function parseNumstat(raw: string): Array<{ path: string; additions: number | null; deletions: number | null; binary: boolean }> {
  return raw.split(/\r?\n/).flatMap((line) => {
    if (!line) return [];
    const [added = "-", deleted = "-", ...pathParts] = line.split("\t");
    return [{ path: pathParts.join("\t"), additions: added === "-" ? null : Number(added), deletions: deleted === "-" ? null : Number(deleted), binary: added === "-" || deleted === "-" }];
  });
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
