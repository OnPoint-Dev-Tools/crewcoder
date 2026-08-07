import fs from "node:fs";
import path from "node:path";
import { parseWorkerList } from "./worker-crews.js";

export type WorkerTeamRole = {
  worker: string;
  role?: string;
  prompt?: string;
};

export type WorkerTeam = {
  id: string;
  description?: string;
  roles: WorkerTeamRole[];
  handoffRules?: string[];
  sharedMemory?: string[];
};

export type WorkerTeamsManifest = {
  path: string;
  teams: WorkerTeam[];
};

export function loadWorkerTeams(cwd = process.cwd()): WorkerTeamsManifest | null {
  const manifestPath = path.join(cwd, "crewcoder.json");
  if (!fs.existsSync(manifestPath)) return null;
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as unknown;
  return { path: manifestPath, teams: normalizeTeams(raw) };
}

export function resolveWorkerTeam(id: string, cwd = process.cwd()): WorkerTeam {
  const manifest = loadWorkerTeams(cwd);
  if (!manifest) throw new Error(`No crewcoder.json found in ${cwd}.`);
  const team = manifest.teams.find((item) => item.id === id);
  if (!team) throw new Error(`Worker team not found: ${id}. Available teams: ${manifest.teams.map((item) => item.id).join(", ") || "(none)"}`);
  return team;
}

export function teamWorkerNames(team: WorkerTeam): string[] {
  return team.roles.map((role) => role.worker);
}

export function buildTeamPrompt(team: WorkerTeam, basePrompt: string, role: WorkerTeamRole): string {
  const lines = [
    `Worker team: ${team.id}`,
    team.description ? `Team description: ${team.description}` : "",
    role.role ? `Your team role: ${role.role}` : "",
    role.prompt ? `Role instructions: ${role.prompt}` : "",
    team.handoffRules?.length ? `Handoff rules:\n${team.handoffRules.map((rule) => `- ${rule}`).join("\n")}` : "",
    team.sharedMemory?.length ? `Shared memory:\n${team.sharedMemory.map((item) => `- ${item}`).join("\n")}` : "",
    "",
    "User task:",
    basePrompt
  ].filter(Boolean);
  return lines.join("\n");
}

function normalizeTeams(raw: unknown): WorkerTeam[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const teams = obj.teams;
  if (Array.isArray(teams)) return teams.flatMap(normalizeTeam);
  if (teams && typeof teams === "object") {
    return Object.entries(teams as Record<string, unknown>).flatMap(([id, value]) => normalizeTeamWithId(id, value));
  }
  return [];
}

function normalizeTeam(raw: unknown): WorkerTeam[] {
  if (!raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id.trim() : "";
  return normalizeTeamWithId(id, raw);
}

function normalizeTeamWithId(id: string, raw: unknown): WorkerTeam[] {
  if (!id || !raw || typeof raw !== "object") return [];
  const obj = raw as Record<string, unknown>;
  const roles = normalizeRoles(obj.roles ?? obj.workers);
  if (!roles.length) return [];
  return [{
    id,
    description: typeof obj.description === "string" && obj.description.trim() ? obj.description.trim() : undefined,
    roles,
    handoffRules: normalizeStringArray(obj.handoffRules),
    sharedMemory: normalizeStringArray(obj.sharedMemory)
  }];
}

function normalizeRoles(raw: unknown): WorkerTeamRole[] {
  if (typeof raw === "string") return parseWorkerList(raw).map((worker) => ({ worker }));
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item === "string" && item.trim()) return [{ worker: item.trim() }];
    if (!item || typeof item !== "object") return [];
    const obj = item as Record<string, unknown>;
    const worker = typeof obj.worker === "string" ? obj.worker.trim() : typeof obj.name === "string" ? obj.name.trim() : "";
    if (!worker) return [];
    return [{
      worker,
      role: typeof obj.role === "string" && obj.role.trim() ? obj.role.trim() : undefined,
      prompt: typeof obj.prompt === "string" && obj.prompt.trim() ? obj.prompt.trim() : undefined
    }];
  });
}

function normalizeStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return values.length ? values : undefined;
}
