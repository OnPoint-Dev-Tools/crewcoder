import fs from "node:fs";
import path from "node:path";
import type { CrewCoderConfig } from "./config.js";

export type IntegrationProfile = "standalone" | "crewcode";

export const DEFAULT_INTEGRATION_PROFILE: IntegrationProfile = "standalone";

export function isIntegrationProfile(value: unknown): value is IntegrationProfile {
  return value === "standalone" || value === "crewcode";
}

export function resolveIntegrationProfile(cwd: string, config: Pick<CrewCoderConfig, "integrationProfile">): IntegrationProfile {
  const project = readProjectIntegrationProfile(cwd);
  return project ?? config.integrationProfile ?? DEFAULT_INTEGRATION_PROFILE;
}

export function readProjectIntegrationProfile(cwd = process.cwd()): IntegrationProfile | undefined {
  const file = path.join(path.resolve(cwd), "crewcoder.json");
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { integrationProfile?: unknown };
    return isIntegrationProfile(raw.integrationProfile) ? raw.integrationProfile : undefined;
  } catch {
    return undefined;
  }
}

export type CrewCodeProjectDetection = {
  detected: boolean;
  markers: string[];
  dismissed: boolean;
  hasProjectProfile: boolean;
  shouldPrompt: boolean;
};

function readProjectManifest(cwd: string): { file: string; raw: Record<string, unknown> } {
  const file = path.join(path.resolve(cwd), "crewcoder.json");
  if (!fs.existsSync(file)) return { file, raw: {} };
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} must contain a JSON object.`);
  return { file, raw: parsed as Record<string, unknown> };
}

export function detectCrewCodeProject(cwd = process.cwd()): CrewCodeProjectDetection {
  const root = path.resolve(cwd);
  const markers: string[] = [];
  if (fs.existsSync(path.join(root, "crewcode.plugin.json"))) markers.push("crewcode.plugin.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as Record<string, unknown>;
    if (pkg.crewcode && typeof pkg.crewcode === "object") markers.push("package.json#crewcode");
  } catch {}
  let manifest: Record<string, unknown> = {};
  try { manifest = readProjectManifest(root).raw; } catch {}
  const hasProjectProfile = isIntegrationProfile(manifest.integrationProfile);
  const dismissed = manifest.crewcodeProfilePromptDismissed === true;
  return { detected: markers.length > 0, markers, dismissed, hasProjectProfile, shouldPrompt: markers.length > 0 && !dismissed && !hasProjectProfile };
}

export function setCrewCodeProfilePromptDismissed(cwd: string, dismissed = true): string {
  const { file, raw } = readProjectManifest(cwd);
  fs.writeFileSync(file, `${JSON.stringify({ ...raw, crewcodeProfilePromptDismissed: dismissed }, null, 2)}\n`, "utf8");
  return file;
}

export function setProjectIntegrationProfile(cwd: string, profile: IntegrationProfile): string {
  if (!isIntegrationProfile(profile)) throw new Error("integrationProfile must be one of: standalone, crewcode");
  const { file, raw } = readProjectManifest(cwd);
  const next: Record<string, unknown> = { ...raw, integrationProfile: profile };
  delete next.crewcodeProfilePromptDismissed;
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return file;
}
