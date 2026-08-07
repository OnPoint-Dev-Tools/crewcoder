// Extension installation.
//
// `crewcoder extension install acme/nextjs-workflows` resolves a source spec, clones it
// into a staging directory, validates the manifest there, and only then moves it into
// `<home>/extensions/<manifest.id>`. Staging matters: `loadCrewCoderExtensions()` scans the
// extensions directory on every run, so a half-written or invalid package must never
// appear there.
//
// Install never grants trust. A freshly installed extension is prompt-only until the user
// runs `crewcoder extension trust <id> --tier ...`, so acquisition and execution stay
// separate decisions.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureCrewCoderHome } from "../core/crewcoder-home.js";
import { readConfig, writeConfig } from "../core/config.js";
import { validateExtensionManifest } from "./extension-loader.js";
import { isRegistryAlias, listConfiguredRegistries, resolveRegistryAlias } from "./extension-registry-index.js";
import type { CrewCoderExtensionManifest } from "./types.js";

const manifestName = "crewcoder.extension.json";
const installRecordName = ".crewcoder-install.json";
const backupDirName = ".backups";

export type ExtensionSourceKind = "github" | "git" | "local";

export type ExtensionSourceSpec = {
  /** The spec exactly as the user typed it, stored for `extension update`. */
  raw: string;
  kind: ExtensionSourceKind;
  /** Clone URL for git sources, absolute path for local sources. */
  location: string;
  /** Branch, tag, or commit. Undefined means the source's default branch. */
  ref?: string;
  /** Package subdirectory, for monorepos that hold several extensions. */
  subdir?: string;
};

export type ExtensionCapabilitySummary = {
  /** Contribution points that only take effect at the `trusted` or `sandboxed` tier. */
  tools: number;
  hooks: number;
  fileTriggers: number;
  approvalPolicies: number;
  validators: number;
  liveUi: number;
  /** Contribution points that work at every tier. */
  providers: number;
  skills: number;
  promptPacks: number;
  commands: number;
  workflows: number;
  /** Workflows containing tool steps, which execute without model review. */
  workflowsWithToolSteps: number;
  /** True when the manifest declares an in-process module entry point. */
  hasModule: boolean;
  /** Outbound hosts the manifest requests. */
  networkHosts: string[];
  /** True when anything here stays inert until the user grants trust. */
  requiresTrust: boolean;
};

export type ExtensionInstallRecord = {
  spec: string;
  kind: ExtensionSourceKind;
  location: string;
  ref?: string;
  subdir?: string;
  commit?: string;
  installedAt: string;
  /** Set when the user typed a registry alias; `spec` still holds the resolved source. */
  alias?: string;
  /** The registry that resolved the alias, for provenance. */
  registry?: string;
};

export type ExtensionInstallResult = {
  id: string;
  name: string;
  version: string;
  dir: string;
  record: ExtensionInstallRecord;
  capabilities: ExtensionCapabilitySummary;
  manifestWarnings: string[];
  /** Set when an existing install of the same id was moved aside. */
  backupDir?: string;
};

export type InstallExtensionOptions = {
  /** Explicit source, bypassing shorthand parsing. Git URL or local path. */
  from?: string;
  ref?: string;
  subdir?: string;
  /** Replace an existing install of the same id (the old copy is backed up, not deleted). */
  force?: boolean;
  /** Carried by `extension update` so an alias install keeps its registry provenance. */
  alias?: string;
  registry?: string;
};

const githubShorthand = /^(?<owner>[A-Za-z0-9][A-Za-z0-9._-]*)\/(?<repo>[A-Za-z0-9][A-Za-z0-9._-]*)$/;
const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Parse `owner/repo`, `owner/repo@ref`, `owner/repo@ref#subdir`, a git URL, or a local path.
 */
export function parseExtensionSpec(raw: string, options: InstallExtensionOptions = {}): ExtensionSourceSpec {
  const trimmed = raw.trim();
  if (!trimmed && !options.from) throw new Error("Extension source is required, for example: crewcoder extension install acme/nextjs-workflows");

  const source = (options.from ?? trimmed).trim();
  const hashIndex = source.indexOf("#");
  const withoutSubdir = hashIndex >= 0 ? source.slice(0, hashIndex) : source;
  const inlineSubdir = hashIndex >= 0 ? source.slice(hashIndex + 1) : undefined;
  const subdir = options.subdir ?? (inlineSubdir || undefined);
  if (subdir && (path.isAbsolute(subdir) || subdir.split(/[\\/]/).includes(".."))) {
    throw new Error(`Extension subdirectory must be a relative path inside the source: ${subdir}`);
  }

  // `file://` is a git transport, not a plain copy: it honours refs like any other remote.
  const isUrl = /^(https?:|git:|ssh:|file:|git\+)/.test(withoutSubdir) || withoutSubdir.startsWith("git@");
  const isLocal = !isUrl && (withoutSubdir.startsWith(".") || withoutSubdir.startsWith("~") || path.isAbsolute(withoutSubdir));

  // `@` is a ref separator only after the last `/`, so `git@host:org/repo` and
  // `https://user@host/org/repo` keep their userinfo instead of losing it to a ref.
  const atIndex = isLocal ? -1 : withoutSubdir.lastIndexOf("@");
  const hasRefSuffix = atIndex > 0 && atIndex > withoutSubdir.lastIndexOf("/") && atIndex > withoutSubdir.lastIndexOf(":");
  const base = hasRefSuffix ? withoutSubdir.slice(0, atIndex) : withoutSubdir;
  const ref = options.ref ?? (hasRefSuffix ? withoutSubdir.slice(atIndex + 1) : undefined);
  if (ref !== undefined && !ref.trim()) throw new Error(`Extension ref must not be empty: ${source}`);

  if (isLocal) {
    const home = base.startsWith("~") ? path.join(os.homedir(), base.slice(1)) : base;
    return { raw: source, kind: "local", location: path.resolve(home), ref: undefined, subdir };
  }
  if (isUrl) {
    return { raw: source, kind: "git", location: base, ref, subdir };
  }
  const match = githubShorthand.exec(base);
  if (!match?.groups) {
    throw new Error(`Unrecognized extension source: ${source}. Use owner/repo, owner/repo@ref, a git URL, or a local path.`);
  }
  const repo = match.groups.repo.replace(/\.git$/, "");
  return { raw: source, kind: "github", location: `https://github.com/${match.groups.owner}/${repo}.git`, ref, subdir };
}

/** Describe what a manifest asks for, so install can print it before the user grants trust. */
export function summarizeExtensionCapabilities(manifest: CrewCoderExtensionManifest): ExtensionCapabilitySummary {
  const contributes = manifest.contributes ?? {};
  const summary: ExtensionCapabilitySummary = {
    tools: contributes.tools?.length ?? 0,
    hooks: contributes.hooks?.length ?? 0,
    fileTriggers: contributes.fileTriggers?.length ?? 0,
    approvalPolicies: contributes.approvalPolicies?.length ?? 0,
    validators: contributes.validators?.length ?? 0,
    liveUi: contributes.liveUi?.length ?? 0,
    providers: contributes.providers?.length ?? 0,
    skills: contributes.skills?.length ?? 0,
    promptPacks: contributes.promptPacks?.length ?? 0,
    commands: contributes.commands?.length ?? 0,
    workflows: contributes.workflows?.length ?? 0,
    workflowsWithToolSteps: contributes.workflows?.filter((workflow) => workflow.steps.some((step) => step.kind === "tool")).length ?? 0,
    hasModule: Boolean(manifest.main),
    networkHosts: [...(manifest.permissions?.network?.allowedHosts ?? [])],
    requiresTrust: false
  };
  return {
    ...summary,
    requiresTrust:
      summary.hasModule ||
      summary.tools > 0 ||
      summary.hooks > 0 ||
      summary.fileTriggers > 0 ||
      summary.approvalPolicies > 0 ||
      summary.validators > 0 ||
      summary.liveUi > 0 ||
      summary.workflowsWithToolSteps > 0
  };
}

/** Human-readable one-line capability list for CLI output. */
export function formatCapabilitySummary(summary: ExtensionCapabilitySummary): string[] {
  const parts: string[] = [];
  const add = (count: number, label: string) => { if (count > 0) parts.push(`${count} ${label}${count === 1 ? "" : "s"}`); };
  add(summary.providers, "provider");
  add(summary.skills, "skill");
  add(summary.promptPacks, "prompt pack");
  add(summary.commands, "command");
  if (summary.workflows > 0) {
    const withTools = summary.workflowsWithToolSteps ? ` (${summary.workflowsWithToolSteps} with tool steps)` : "";
    parts.push(`${summary.workflows} workflow${summary.workflows === 1 ? "" : "s"}${withTools}`);
  }
  add(summary.tools, "tool");
  add(summary.hooks, "hook");
  add(summary.fileTriggers, "file trigger");
  add(summary.approvalPolicies, "approval policy");
  add(summary.validators, "validator");
  add(summary.liveUi, "live UI component");
  if (summary.hasModule) parts.push("an in-process module");
  return parts;
}

export async function readInstallRecord(dir: string): Promise<ExtensionInstallRecord | undefined> {
  try {
    const raw = await fs.readFile(path.join(dir, installRecordName), "utf8");
    return JSON.parse(raw) as ExtensionInstallRecord;
  } catch {
    return undefined;
  }
}

/**
 * Turn a bare registry name into a real source spec. Explicit specs (`owner/repo`, a git URL,
 * a path, or `--from`) never reach a registry, so discovery can never redirect an install the
 * user already spelled out.
 */
export async function resolveInstallSpec(rawSpec: string, options: InstallExtensionOptions = {}): Promise<{ spec: string; alias?: string; registry?: string }> {
  const trimmed = rawSpec.trim();
  if (options.from || !isRegistryAlias(trimmed)) return { spec: rawSpec };

  const hit = await resolveRegistryAlias(trimmed);
  if (hit) return { spec: hit.entry.source, alias: trimmed, registry: hit.registryUrl };

  const registries = listConfiguredRegistries();
  throw new Error(
    registries.length
      ? `Extension not found in any configured registry: ${trimmed}. Try 'crewcoder extension search ${trimmed}', or install by source: crewcoder extension install owner/repo`
      : `Unrecognized extension source: ${trimmed}. Use owner/repo, a git URL, or a local path. No registries are enabled, so bare names cannot be resolved; add one with 'crewcoder extension registry add <url>'.`
  );
}

export async function installExtension(rawSpec: string, options: InstallExtensionOptions = {}): Promise<ExtensionInstallResult> {
  const resolved = await resolveInstallSpec(rawSpec, options);
  const spec = parseExtensionSpec(resolved.spec, options);
  const home = ensureCrewCoderHome();
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "crewcoder-ext-"));
  try {
    const checkout = path.join(staging, "source");
    let commit: string | undefined;
    if (spec.kind === "local") {
      await copyLocalSource(spec.location, checkout);
    } else {
      await gitFetchSource(spec, checkout);
      commit = await gitHeadCommit(checkout);
    }

    const packageRoot = spec.subdir ? path.resolve(checkout, spec.subdir) : checkout;
    if (!isInside(checkout, packageRoot)) throw new Error(`Extension subdirectory escapes the source root: ${spec.subdir}`);

    const manifestPath = path.join(packageRoot, manifestName);
    if (!fsSync.existsSync(manifestPath)) {
      throw new Error(`No ${manifestName} found at ${spec.subdir ? `${spec.raw} (subdir ${spec.subdir})` : spec.raw}. This source is not a CrewCoder extension.`);
    }
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as CrewCoderExtensionManifest;
    const manifestWarnings: string[] = [];
    validateExtensionManifest(manifest, manifestWarnings);

    // The install directory name IS the extension id: getExtensionDir(), trust, enable, and
    // disable all key off manifest.id. An id that is not a plain path segment would let a
    // manifest write outside the extensions directory.
    if (!safeIdPattern.test(manifest.id)) {
      throw new Error(`Extension id is not a safe directory name: ${manifest.id}`);
    }

    const target = path.join(home.extensionsDir, manifest.id);
    let backupDir: string | undefined;
    if (fsSync.existsSync(target)) {
      if (!options.force) {
        throw new Error(`Extension ${manifest.id} is already installed at ${target}. Use --force to replace it, or 'crewcoder extension update ${manifest.id}'.`);
      }
      backupDir = await backupExtensionDir(home.extensionsDir, manifest.id);
    }

    // Drop VCS metadata; nothing in CrewCoder reads it and it bloats the install.
    await fs.rm(path.join(packageRoot, ".git"), { recursive: true, force: true });

    const record: ExtensionInstallRecord = {
      spec: spec.raw,
      kind: spec.kind,
      location: spec.location,
      ref: spec.ref,
      subdir: spec.subdir,
      commit,
      installedAt: new Date().toISOString(),
      alias: resolved.alias ?? options.alias,
      registry: resolved.registry ?? options.registry
    };
    await fs.writeFile(path.join(packageRoot, installRecordName), `${JSON.stringify(record, null, 2)}\n`, "utf8");

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.cp(packageRoot, target, { recursive: true });

    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      dir: target,
      record,
      capabilities: summarizeExtensionCapabilities(manifest),
      manifestWarnings,
      backupDir
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function updateExtension(id: string, options: { force?: boolean } = {}): Promise<ExtensionInstallResult> {
  const home = ensureCrewCoderHome();
  const dir = path.join(home.extensionsDir, id);
  if (!fsSync.existsSync(dir)) throw new Error(`Extension not installed: ${id}`);
  const record = await readInstallRecord(dir);
  if (!record) {
    throw new Error(`Extension ${id} has no install record, so its source is unknown. It was created locally or copied in by hand; reinstall it with 'crewcoder extension install <source> --force'.`);
  }
  return installExtension(record.spec, {
    from: record.kind === "local" ? record.location : undefined,
    ref: record.ref,
    subdir: record.subdir,
    alias: record.alias,
    registry: record.registry,
    force: options.force ?? true
  });
}

export type UninstallResult = { id: string; backupDir: string; configCleaned: boolean };

export async function uninstallExtension(id: string): Promise<UninstallResult> {
  const home = ensureCrewCoderHome();
  const dir = path.join(home.extensionsDir, id);
  if (!fsSync.existsSync(dir)) throw new Error(`Extension not installed: ${id}`);
  const backupDir = await backupExtensionDir(home.extensionsDir, id);

  // Trust/enable state is keyed by id, so leaving it behind would silently re-apply to a
  // future extension that happens to reuse the id.
  const config = readConfig();
  const trustedExtensions = config.trustedExtensions.filter((entry) => entry !== id);
  const sandboxedExtensions = config.sandboxedExtensions.filter((entry) => entry !== id);
  const disabledExtensions = config.disabledExtensions.filter((entry) => entry !== id);
  const configCleaned =
    trustedExtensions.length !== config.trustedExtensions.length ||
    sandboxedExtensions.length !== config.sandboxedExtensions.length ||
    disabledExtensions.length !== config.disabledExtensions.length;
  if (configCleaned) writeConfig({ ...config, trustedExtensions, sandboxedExtensions, disabledExtensions });

  return { id, backupDir, configCleaned };
}

async function backupExtensionDir(extensionsDir: string, id: string): Promise<string> {
  const backupsRoot = path.join(extensionsDir, backupDirName);
  await fs.mkdir(backupsRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(backupsRoot, `${id}-${stamp}`);
  await fs.rename(path.join(extensionsDir, id), backupDir);
  return backupDir;
}

async function copyLocalSource(source: string, dest: string): Promise<void> {
  if (!fsSync.existsSync(source)) throw new Error(`Local extension source not found: ${source}`);
  const stats = await fs.stat(source);
  if (!stats.isDirectory()) throw new Error(`Local extension source must be a directory: ${source}`);
  await fs.cp(source, dest, { recursive: true });
}

async function gitFetchSource(spec: ExtensionSourceSpec, dest: string): Promise<void> {
  await assertGitAvailable();
  const shallow = ["clone", "--depth", "1", "--quiet", ...(spec.ref ? ["--branch", spec.ref] : []), spec.location, dest];
  const first = await runGit(shallow);
  if (first.code === 0) return;

  // `--branch` rejects raw commit shas, so fall back to a full clone plus checkout.
  if (!spec.ref) throw new Error(`Failed to clone ${spec.location}: ${first.stderr.trim() || `git exited with ${first.code}`}`);
  await fs.rm(dest, { recursive: true, force: true });
  const full = await runGit(["clone", "--quiet", spec.location, dest]);
  if (full.code !== 0) throw new Error(`Failed to clone ${spec.location}: ${full.stderr.trim() || `git exited with ${full.code}`}`);
  const checkout = await runGit(["-C", dest, "checkout", "--quiet", spec.ref]);
  if (checkout.code !== 0) throw new Error(`Ref not found in ${spec.location}: ${spec.ref}`);
}

async function gitHeadCommit(dir: string): Promise<string | undefined> {
  const result = await runGit(["-C", dir, "rev-parse", "HEAD"]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function assertGitAvailable(): Promise<void> {
  const result = await runGit(["--version"]);
  if (result.code !== 0) throw new Error("git was not found on PATH. Installing an extension from a repository requires git.");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

type GitResult = { code: number; stdout: string; stderr: string };

function runGit(args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    // No shell: spec values reach git as literal argv entries.
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error: Error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code: number | null) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
