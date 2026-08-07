import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createSessionCheckpoint, type SessionCheckpoint } from "./session-checkpoints.js";

const execFileAsync = promisify(execFile);

export type GitStatusEntry = {
  path: string;
  index: string;
  workingTree: string;
  raw: string;
};

export type GitStatus = {
  branch?: string;
  clean: boolean;
  entries: GitStatusEntry[];
  raw: string;
};

export type GitIssueReference = {
  id: string;
  source: "branch" | "commit" | "status";
  text: string;
  url?: string;
};

export type GitIssueProviderKind = "github" | "gitlab" | "linear" | "jira" | "custom";

export type GitIssueProviderConfig = {
  id: string;
  kind: GitIssueProviderKind;
  label: string;
  enabled: boolean;
  baseUrl?: string;
  projectKey?: string;
  issueUrlTemplate?: string;
};

export type GitStructuredIssue = {
  providerId: string;
  id: string;
  key: string;
  title: string;
  status?: string;
  assignees?: string[];
  labels?: string[];
  url?: string;
  sourceReferences: GitIssueReference[];
};

export type GitReviewIssueProviderPlan = {
  providers: GitIssueProviderConfig[];
  issues: GitStructuredIssue[];
};

export type GitReviewSummary = {
  branch?: string;
  clean: boolean;
  changedFiles: string[];
  issueReferences: GitIssueReference[];
  status: GitStatus;
};

export type GitWorkflowHelpers = {
  status(): Promise<GitStatus>;
  currentBranch(): Promise<string | undefined>;
  changedFiles(): Promise<string[]>;
  createCheckpoint(reason: string): Promise<SessionCheckpoint>;
  issueReferences(): Promise<GitIssueReference[]>;
  reviewSummary(): Promise<GitReviewSummary>;
};

export function createGitWorkflowHelpers(options: { cwd: string; sessionId?: string }): GitWorkflowHelpers {
  const helpers: GitWorkflowHelpers = {
    async status() {
      const [branch, raw] = await Promise.all([
        git(options.cwd, ["branch", "--show-current"]),
        git(options.cwd, ["status", "--porcelain"])
      ]);
      const entries = parsePorcelainStatus(raw);
      return { branch: branch || undefined, clean: entries.length === 0, entries, raw };
    },
    async currentBranch() {
      return await git(options.cwd, ["branch", "--show-current"]) || undefined;
    },
    async changedFiles() {
      const raw = await git(options.cwd, ["status", "--porcelain"]);
      return [...new Set(parsePorcelainStatus(raw).map((entry) => entry.path))];
    },
    async createCheckpoint(reason) {
      if (!options.sessionId) throw new Error("Cannot create git workflow checkpoint without an active session.");
      return createSessionCheckpoint({ sessionId: options.sessionId, cwd: options.cwd, reason: reason.trim() || "Git workflow checkpoint" });
    },
    async issueReferences() {
      const [branch, commits, rawStatus, remoteUrl] = await Promise.all([
        helpers.currentBranch(),
        git(options.cwd, ["log", "-10", "--pretty=%s"]),
        git(options.cwd, ["status", "--porcelain"]),
        git(options.cwd, ["remote", "get-url", "origin"])
      ]);
      const issueBaseUrl = issueBaseUrlFromRemote(remoteUrl);
      return uniqueIssueReferences([
        ...extractIssueReferences(branch ?? "", "branch", issueBaseUrl),
        ...extractIssueReferences(commits, "commit", issueBaseUrl),
        ...extractIssueReferences(rawStatus, "status", issueBaseUrl)
      ]);
    },
    async reviewSummary() {
      const [status, issueReferences] = await Promise.all([helpers.status(), helpers.issueReferences()]);
      return { branch: status.branch, clean: status.clean, changedFiles: status.entries.map((entry) => entry.path), issueReferences, status };
    }
  };
  return helpers;
}

export function extractIssueReferences(text: string, source: GitIssueReference["source"], issueBaseUrl?: string): GitIssueReference[] {
  const matches = text.matchAll(/(?:#|GH-|ISSUE-|issue[-_/])([0-9]+)/gi);
  return [...matches].map((match) => {
    const id = match[1] ?? "";
    return { id, source, text: match[0] ?? "", url: issueBaseUrl && id ? `${issueBaseUrl}/${id}` : undefined };
  }).filter((item) => item.id);
}

export function issueBaseUrlFromRemote(remoteUrl: string): string | undefined {
  const normalized = remoteUrl.trim().replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "");
  const match = normalized.match(/^https?:\/\/([^/]+)\/(.+)$/);
  if (!match) return undefined;
  const host = match[1];
  const repo = match[2];
  if (!host || !repo) return undefined;
  if (host.includes("github.com")) return `https://${host}/${repo}/issues`;
  if (host.includes("gitlab.com")) return `https://${host}/${repo}/-/issues`;
  return undefined;
}

function uniqueIssueReferences(references: GitIssueReference[]): GitIssueReference[] {
  const seen = new Set<string>();
  const result: GitIssueReference[] = [];
  for (const reference of references) {
    const key = `${reference.id}:${reference.source}:${reference.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(reference);
  }
  return result;
}

export function parsePorcelainStatus(raw: string): GitStatusEntry[] {
  return raw.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    const index = line[0] ?? " ";
    const workingTree = line[1] ?? " ";
    const body = line.slice(3).trim();
    const path = body.includes(" -> ") ? body.split(" -> ").at(-1) ?? body : body;
    return [{ path, index, workingTree, raw: line }];
  });
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 1500, maxBuffer: 128_000 });
    return stdout.trim();
  } catch {
    return "";
  }
}
