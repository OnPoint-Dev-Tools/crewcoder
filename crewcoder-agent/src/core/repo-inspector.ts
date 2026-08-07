import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ProjectInspection = {
  cwd: string;
  repoRoot?: string;
  gitBranch?: string;
  gitStatus?: string;
  packageName?: string;
  packageManager?: string;
  scripts?: string[];
  markers: string[];
};

const markerFiles = [
  "AGENTS.md",
  "README.md",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod"
];

export async function inspectProject(cwd: string): Promise<ProjectInspection> {
  const repoRoot = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const root = repoRoot || cwd;
  const packageJson = await readPackageJson(root);
  const markers = await existingMarkers(root);
  return {
    cwd,
    repoRoot: repoRoot || undefined,
    gitBranch: await git(cwd, ["branch", "--show-current"]) || undefined,
    gitStatus: await git(cwd, ["status", "--short"]) || undefined,
    packageName: typeof packageJson?.name === "string" ? packageJson.name : undefined,
    packageManager: typeof packageJson?.packageManager === "string" ? packageJson.packageManager : inferPackageManager(root),
    scripts: packageJson?.scripts && typeof packageJson.scripts === "object" ? Object.keys(packageJson.scripts).sort() : undefined,
    markers
  };
}

export function formatProjectInspection(inspection: ProjectInspection): string {
  const lines = [
    `cwd: ${inspection.cwd}`,
    inspection.repoRoot ? `repoRoot: ${inspection.repoRoot}` : undefined,
    inspection.gitBranch ? `gitBranch: ${inspection.gitBranch}` : undefined,
    inspection.gitStatus ? `gitStatus:\n${indent(inspection.gitStatus)}` : "gitStatus: clean or unavailable",
    inspection.packageName ? `package: ${inspection.packageName}` : undefined,
    inspection.packageManager ? `packageManager: ${inspection.packageManager}` : undefined,
    inspection.scripts?.length ? `scripts: ${inspection.scripts.join(", ")}` : undefined,
    inspection.markers.length ? `markers: ${inspection.markers.join(", ")}` : undefined
  ].filter((line): line is string => Boolean(line));
  return lines.join("\n");
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, timeout: 1500, maxBuffer: 128_000 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function readPackageJson(root: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function inferPackageManager(root: string): string | undefined {
  return existsSync(path.join(root, "bun.lock")) ? "bun"
    : existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm"
    : existsSync(path.join(root, "yarn.lock")) ? "yarn"
    : existsSync(path.join(root, "package-lock.json")) ? "npm"
    : undefined;
}

async function existingMarkers(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const file of markerFiles) {
    try {
      await fs.access(path.join(root, file));
      found.push(file);
    } catch {}
  }
  return found;
}

function existsSync(file: string): boolean {
  return fsSync.existsSync(file);
}

function indent(text: string): string {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}
