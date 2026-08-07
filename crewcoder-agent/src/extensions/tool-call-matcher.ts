// Shared tool-call matching for extension approval policies and hooks.
//
// Both contribution points need "does this tool call match tools/paths/commands patterns?"
// with identical semantics, so the glob/regex/substring rules live here rather than being
// reimplemented per feature and drifting apart.

import path from "node:path";
import type { ToolCallPart } from "../core/messages.js";

export type ToolCallMatchers = {
  /** Tool name patterns: substring, `*` glob, or `/regex/`. */
  tools?: string[];
  /** Path-like argument patterns, glob-matched against path args. */
  paths?: string[];
  /** Bash command patterns: substring, glob, or `/regex/`. */
  commands?: string[];
};

export function hasAnyMatcher(matchers: ToolCallMatchers): boolean {
  return Boolean(matchers.tools?.length || matchers.paths?.length || matchers.commands?.length);
}

/**
 * True when every declared matcher group matches. Groups are ANDed; patterns within a group
 * are ORed. A group with no patterns is not a constraint, so `{}` matches everything —
 * callers that need "no matchers means never" should gate on `hasAnyMatcher` first.
 */
export function matchesToolCall(matchers: ToolCallMatchers, toolCall: ToolCallPart): boolean {
  if (matchers.tools?.length && !matchers.tools.some((pattern) => matchText(pattern, toolCall.name))) return false;
  if (matchers.paths?.length && !pathArgs(toolCall.arguments).some((candidate) => matchers.paths?.some((pattern) => matchPath(pattern, candidate)))) return false;
  if (matchers.commands?.length) {
    const command = typeof toolCall.arguments.command === "string" ? toolCall.arguments.command : "";
    if (!command || !matchers.commands.some((pattern) => matchText(pattern, command))) return false;
  }
  return true;
}

export function pathArgs(args: Record<string, unknown>): string[] {
  const values = ["path", "file", "directory", "target", "cwd", "out"]
    .map((key) => args[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  const cwd = typeof args.cwd === "string" && path.isAbsolute(args.cwd) ? args.cwd : undefined;
  const candidates = new Set<string>();
  for (const value of values) {
    candidates.add(value);
    if (cwd && path.isAbsolute(value)) candidates.add(path.relative(cwd, value));
  }
  return [...candidates];
}

export function matchPath(pattern: string, candidate: string): boolean {
  return globToRegExp(normalizePath(pattern)).test(normalizePath(candidate));
}

export function matchText(pattern: string, candidate: string): boolean {
  if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
    try {
      return new RegExp(pattern.slice(1, -1)).test(candidate);
    } catch {
      return candidate.includes(pattern);
    }
  }
  if (pattern.includes("*") || pattern.includes("?")) return globToRegExp(pattern).test(candidate);
  return candidate.includes(pattern);
}

function normalizePath(value: string): string {
  return path.posix.normalize(value.replaceAll(path.sep, "/")).replace(/^\.\//, "");
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    const next = pattern[i + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += ".";
    } else {
      source += escapeRegExp(char ?? "");
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
