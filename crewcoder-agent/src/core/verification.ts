import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { readConfig } from "./config.js";
import { listEnabledExtensions } from "../extensions/extension-registry.js";
import type { LoadedCrewCoderExtension } from "../extensions/types.js";

export type VerificationCheck = { id: string; title: string; command: string; args: string[]; cwd: string; timeoutMs: number };
export type VerificationResult = { id: string; title: string; ok: boolean; output: string; durationMs: number };

const MAX_OUTPUT = 120_000;

export async function loadVerificationChecks(cwd: string): Promise<VerificationCheck[]> {
  return [...await builtInChecks(cwd), ...await extensionChecks(cwd)];
}

export async function runVerificationChecks(checks: VerificationCheck[], signal?: AbortSignal): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const check of checks) results.push(await runCheck(check, signal));
  return results;
}

async function builtInChecks(cwd: string): Promise<VerificationCheck[]> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
    const checks: VerificationCheck[] = [];
    if (typeof pkg.scripts?.typecheck === "string") checks.push({ id: "typecheck", title: "Typecheck", command: "npm", args: ["run", "typecheck"], cwd, timeoutMs: 120_000 });
    if (typeof pkg.scripts?.test === "string") checks.push({ id: "test", title: "Tests", command: "npm", args: ["test"], cwd, timeoutMs: 120_000 });
    return checks;
  } catch { return []; }
}

async function extensionChecks(cwd: string): Promise<VerificationCheck[]> {
  const config = readConfig();
  if (!config.allowExtensionHooks) return [];
  const trusted = new Set(config.trustedExtensions);
  return (await listEnabledExtensions())
    .filter((extension) => trusted.has(extension.manifest.id))
    .flatMap((extension) => validatorsFromExtension(extension, cwd));
}

function validatorsFromExtension(extension: LoadedCrewCoderExtension, cwd: string): VerificationCheck[] {
  return (extension.manifest.contributes?.validators ?? []).flatMap((value) => {
    const validator = value as { id?: unknown; title?: unknown; command?: unknown; args?: unknown; timeoutMs?: unknown };
    if (typeof validator.id !== "string" || typeof validator.title !== "string" || typeof validator.command !== "string" || !validator.command.trim()) return [];
    const args = Array.isArray(validator.args) ? validator.args.filter((arg): arg is string => typeof arg === "string") : [];
    const timeoutMs = typeof validator.timeoutMs === "number" && Number.isFinite(validator.timeoutMs) ? Math.min(Math.max(Math.trunc(validator.timeoutMs), 1_000), 120_000) : 30_000;
    return [{ id: `${extension.manifest.id}:${validator.id}`, title: validator.title, command: validator.command, args, cwd, timeoutMs }];
  });
}

function runCheck(check: VerificationCheck, signal?: AbortSignal): Promise<VerificationResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(check.command, check.args, { cwd: check.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const append = (chunk: Buffer) => { output += chunk.toString(); if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, check.timeoutMs);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => append(Buffer.from(error.message)));
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const suffix = timedOut ? `\nTimed out after ${check.timeoutMs}ms.` : "";
      resolve({ id: check.id, title: check.title, ok: code === 0 && !timedOut, output: (output + suffix).trim() || "(no output)", durationMs: Date.now() - started });
    });
  });
}
