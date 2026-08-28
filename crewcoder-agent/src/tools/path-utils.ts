import fs from "node:fs";
import path from "node:path";
import { resolveSkillCatalogRoots } from "../skills/filesystem/loader.js";

export function resolveInsideCwd(cwd: string, userPath: string, externalDirectories: readonly string[] = [], extraReadableRoots: readonly string[] = []): string {
  if (!userPath || typeof userPath !== "string") throw new Error("path is required");
  const resolved = canonicalizePotentialPath(path.resolve(cwd, userPath));
  const roots = [cwd, ...externalDirectories, ...extraReadableRoots].map((root) => canonicalizePotentialPath(path.resolve(root)));
  if (!roots.some((root) => resolved === root || resolved.startsWith(root + path.sep))) {
    throw new Error(`Path is outside the workspace and session external directories: ${userPath}`);
  }
  return resolved;
}

/** Read/search tools may open on-demand skill catalogs; mutations still use `resolveInsideCwd`. */
export function resolveReadablePath(cwd: string, userPath: string, externalDirectories: readonly string[] = []): string {
  return resolveInsideCwd(cwd, userPath, externalDirectories, resolveSkillCatalogRoots());
}

export function isPathInsideSkillCatalog(candidate: string, cwd = process.cwd()): boolean {
  const resolved = canonicalizePotentialPath(path.resolve(cwd, candidate));
  return resolveSkillCatalogRoots().some((root) => {
    const canonicalRoot = canonicalizePotentialPath(path.resolve(root));
    return resolved === canonicalRoot || resolved.startsWith(canonicalRoot + path.sep);
  });
}

/** Resolve symlinks in the nearest existing ancestor while still permitting new files. */
function canonicalizePotentialPath(value: string): string {
  let existing = value;
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const canonical = fs.existsSync(existing) ? fs.realpathSync.native(existing) : existing;
  return path.join(canonical, ...missing);
}
export function relativeToCwd(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  if (!relative) return ".";
  return relative === ".." || relative.startsWith(`..${path.sep}`) ? absolutePath : relative;
}
export function assertSafeRelativeEntry(entry: string): void {
  if (!entry || typeof entry !== "string") throw new Error("entry path is required");
  if (path.isAbsolute(entry) || entry.includes("..")) throw new Error(`Entry must be a relative path inside the plugin folder: ${entry}`);
}
