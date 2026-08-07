/**
 * IDENTITY & WORKERS
 * ==================
 *
 * This module defines CrewCoder's *worker* system. A "worker" is a named agent
 * identity the user can switch between (e.g. "Crew", "Twitter-Crew").
 *
 * Two distinct layers of instruction exist in CrewCoder — do not conflate them:
 *
 *   IDENTITY (this module)
 *     - Per-worker. Lives in ~/.crewcoder/workers/<Name>/.
 *     - identity.json  -> structured identity (workerName, owner, description).
 *     - IDENTITY.md    -> freeform worker persona/instructions. Its full body is
 *                         loaded by readWorker and embedded verbatim into the
 *                         identity block, so it is always in context.
 *     - Defines WHO the active agent is and HOW that specific worker behaves.
 *
 *   Injection: the identity block (owner lines + the embedded IDENTITY.md body)
 *   is included in the system prompt (buildSystemPrompt) on every run. Because
 *   the system prompt is a static prefix, provider prompt caching keeps the
 *   repeated per-turn cost cheap. Keep IDENTITY.md focused for this reason.
 *
 *   ROOT AGENTS.md (repo root, NOT loaded here)
 *     - Repo-wide documentation: coding standards + overall dev guidelines for
 *       people/agents working ON the CrewCoder codebase itself.
 *     - It is documentation only and is never injected into the system prompt.
 *
 * On first use, a default worker named "Crew" is created automatically and set
 * active, so a fresh install always has a working identity until the user adds
 * or switches workers. A legacy single ~/.crewcoder/identity.json (from the
 * earlier single-identity design) is migrated into the default worker once.
 *
 * Workers are global (CrewCoder home), shared across every project.
 */
import fs from "node:fs";
import path from "node:path";
import { ensureCrewCoderHome } from "./crewcoder-home.js";
import { readConfig, setActiveWorkerName } from "./config.js";

export interface CrewCoderIdentity {
  workerName: string;
  ownerName?: string;
  ownerHandle?: string;
  description?: string;
  createdAt: string;
}

export interface CrewCoderWorker {
  name: string;
  dir: string;
  identity: CrewCoderIdentity;
  instructions?: string;
  instructionsPath?: string;
}

export type IdentitySetKey = "owner-name" | "owner-handle" | "description";

export const DEFAULT_WORKER_NAME = "Crew";
const DEFAULT_OWNER_NAME = "CrewCoder User";
const DEFAULT_OWNER_HANDLE = "@CrewCoderUser";

export function getWorkersDir(): string {
  return path.join(ensureCrewCoderHome().root, "workers");
}

export function getWorkerIdentityMdPath(name: string): string {
  return path.join(getWorkersDir(), name, "IDENTITY.md");
}

export function listWorkers(): CrewCoderWorker[] {
  const dir = getWorkersDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readWorker(entry.name))
    .filter((worker): worker is CrewCoderWorker => worker !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function readWorker(name: string): CrewCoderWorker | null {
  const dir = path.join(getWorkersDir(), name);
  if (!fs.existsSync(dir)) return null;

  const identityJsonPath = path.join(dir, "identity.json");
  let identity: CrewCoderIdentity | null;
  if (fs.existsSync(identityJsonPath)) {
    try {
      identity = normalizeIdentity(name, JSON.parse(fs.readFileSync(identityJsonPath, "utf8")));
    } catch {
      return null;
    }
    if (!identity) return null;
  } else {
    // Self-heal: worker dir exists but identity.json is missing -> create a default.
    identity = { workerName: name, createdAt: new Date().toISOString() };
    fs.writeFileSync(identityJsonPath, JSON.stringify(identity, null, 2) + "\n", "utf8");
  }

  // Self-heal: missing IDENTITY.md -> create a default from the template.
  const identityMdPath = path.join(dir, "IDENTITY.md");
  if (!fs.existsSync(identityMdPath)) {
    fs.writeFileSync(identityMdPath, defaultWorkerIdentityMd(name), "utf8");
  }
  const instructions = fs.readFileSync(identityMdPath, "utf8");
  return { name, dir, identity, instructions, instructionsPath: identityMdPath };
}

export function createWorker(
  name: string,
  opts: { ownerName?: string; ownerHandle?: string; description?: string } = {}
): CrewCoderWorker {
  const validName = validateWorkerName(name);
  const dir = path.join(getWorkersDir(), validName);
  if (fs.existsSync(dir)) throw new Error(`Worker already exists: ${validName}`);
  fs.mkdirSync(dir, { recursive: true });
  const identity: CrewCoderIdentity = {
    workerName: validName,
    ownerName: opts.ownerName?.trim() || undefined,
    ownerHandle: opts.ownerHandle?.trim() || undefined,
    description: opts.description?.trim() || undefined,
    createdAt: new Date().toISOString(),
  };
  const instructions = defaultWorkerIdentityMd(validName);
  const instructionsPath = path.join(dir, "IDENTITY.md");
  fs.writeFileSync(path.join(dir, "identity.json"), JSON.stringify(identity, null, 2) + "\n", "utf8");
  fs.writeFileSync(instructionsPath, instructions, "utf8");
  return { name: validName, dir, identity, instructions, instructionsPath };
}

export function deleteWorker(name: string): void {
  const dir = path.join(getWorkersDir(), name);
  if (!fs.existsSync(dir)) throw new Error(`Worker not found: ${name}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

export function setWorkerIdentityValue(name: string, key: IdentitySetKey, value: string): CrewCoderWorker {
  const worker = readWorker(name);
  if (!worker) throw new Error(`Worker not found: ${name}`);
  const identity: CrewCoderIdentity = { ...worker.identity };
  if (key === "owner-name") {
    identity.ownerName = value.trim() || undefined;
  } else if (key === "owner-handle") {
    identity.ownerHandle = value.trim() || undefined;
  } else if (key === "description") {
    identity.description = value.trim() || undefined;
  } else {
    throw new Error(`Unknown identity key: ${String(key)}. Supported: owner-name, owner-handle, description`);
  }
  fs.writeFileSync(path.join(worker.dir, "identity.json"), JSON.stringify(identity, null, 2) + "\n", "utf8");
  return { ...worker, identity };
}

export function ensureDefaultWorker(): CrewCoderWorker {
  const existing = readWorker(DEFAULT_WORKER_NAME);
  if (existing) return existing;

  const home = ensureCrewCoderHome();
  const legacyPath = path.join(home.root, "identity.json");
  let seed: { ownerName?: string; ownerHandle?: string } = {
    ownerName: DEFAULT_OWNER_NAME,
    ownerHandle: DEFAULT_OWNER_HANDLE,
  };
  if (fs.existsSync(legacyPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as Record<string, unknown>;
      seed = {
        ownerName: typeof raw["ownerName"] === "string" && raw["ownerName"].trim() ? raw["ownerName"].trim() : DEFAULT_OWNER_NAME,
        ownerHandle: typeof raw["ownerHandle"] === "string" && raw["ownerHandle"].trim() ? raw["ownerHandle"].trim() : DEFAULT_OWNER_HANDLE,
      };
    } catch {
      // Keep the safe starter identity when legacy data is malformed.
    }
  }

  const worker = createWorker(DEFAULT_WORKER_NAME, {
    ownerName: seed.ownerName,
    ownerHandle: seed.ownerHandle,
  });

  if (fs.existsSync(legacyPath)) {
    try {
      fs.unlinkSync(legacyPath);
    } catch {
      // ignore
    }
  }
  return worker;
}

export function getActiveWorker(): CrewCoderWorker {
  const config = readConfig();
  const desired = config.activeWorker?.trim() || DEFAULT_WORKER_NAME;
  const existing = readWorker(desired);
  if (existing) return existing;
  const fallback = ensureDefaultWorker();
  if (desired !== fallback.name) setActiveWorkerName(fallback.name);
  return fallback;
}

/**
 * Resolve the worker for a single run. An explicit `name` (e.g. from a CLI
 * `--worker` flag) wins and is per-run only — it does NOT mutate the persisted
 * active worker. When omitted, falls back to the persisted active worker.
 */
export function resolveActiveWorker(name?: string): CrewCoderWorker {
  const trimmed = name?.trim();
  if (!trimmed) return getActiveWorker();
  const worker = readWorker(trimmed);
  if (!worker) throw new Error(`Worker not found: ${trimmed}. Create it with: crewcoder workers create ${trimmed}`);
  return worker;
}

export function setActiveWorker(name: string): CrewCoderWorker {
  const worker = readWorker(name);
  if (!worker) throw new Error(`Worker not found: ${name}. Create it with: crewcoder workers create ${name}`);
  setActiveWorkerName(worker.name);
  return worker;
}

export function buildIdentityPrompt(worker: CrewCoderWorker): string {
  const id = worker.identity;
  const lines: string[] = [
    `You are ${worker.name}, the active worker for this CrewCoder instance.`,
  ];
  if (id.ownerName) {
    lines.push(`This instance is owned and operated by ${id.ownerName}.`);
    lines.push(`Refer to your owner as "${id.ownerName}" when addressing them directly.`);
  }
  if (id.ownerHandle) lines.push(`Your owner goes by "${id.ownerHandle}" in their projects.`);
  if (id.description) lines.push(id.description);
  if (worker.instructions && worker.instructions.trim()) {
    lines.push("", "--- Worker identity (IDENTITY.md) ---", worker.instructions.trim());
  }
  return lines.join("\n");
}

function validateWorkerName(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(trimmed)) {
    throw new Error(`Invalid worker name "${name}". Use letters, numbers, hyphen, underscore (e.g. Crew, Twitter-Crew).`);
  }
  return trimmed;
}

function normalizeIdentity(workerName: string, raw: unknown): CrewCoderIdentity | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  return {
    workerName,
    ownerName:
      typeof obj["ownerName"] === "string" && obj["ownerName"].trim() ? obj["ownerName"].trim() : undefined,
    ownerHandle:
      typeof obj["ownerHandle"] === "string" && obj["ownerHandle"].trim() ? obj["ownerHandle"].trim() : undefined,
    description:
      typeof obj["description"] === "string" && obj["description"].trim() ? obj["description"].trim() : undefined,
    createdAt:
      typeof obj["createdAt"] === "string" && obj["createdAt"] ? obj["createdAt"] : new Date().toISOString(),
  };
}

function defaultWorkerIdentityMd(name: string): string {
  if (name === DEFAULT_WORKER_NAME) {
    return [
      "# Crew — Worker Identity",
      "",
      "<!-- This file is read by the agent at session start whenever the `Crew` worker is active. Edit it to shape who this worker is and how it behaves. Keep it focused and task-specific. -->",
      "",
      "You are Crew, a practical general-purpose coding partner for the CrewCoder User.",
      "Be direct, dependable, and collaborative. Favor correct, maintainable solutions over impressive but unnecessary complexity.",
      "",
      "## Role",
      "",
      "- Help the user understand, build, debug, review, and maintain software.",
      "- Adapt to the repository's existing architecture, conventions, and constraints.",
      "- Surface uncertainty, risks, and tradeoffs instead of hiding them.",
      "",
      "## Working Style",
      "",
      "- Inspect the real implementation and reproduce problems before changing code.",
      "- Prefer the smallest coherent change that fully solves the request.",
      "- Preserve user work and avoid unrelated edits.",
      "- Verify relevant behavior before reporting completion.",
      "- Communicate clearly: explain what changed, what was verified, and what remains.",
      "",
      "## Customization",
      "",
      "Edit this file to give Crew your preferred specialties, tone, workflows, or collaboration style.",
      "",
    ].join("\n");
  }

  return [
    `# ${name} — Worker Identity`,
    "",
    `You are ${name}, a specialized worker in CrewCoder.`,
    "Edit this file to define the worker's role, expertise, working style, and boundaries.",
    "",
    "## Role",
    "",
    "- Describe what this worker specializes in.",
    "",
    "## Guidelines",
    "",
    "- Add task-specific rules here.",
    "",
  ].join("\n");
}
