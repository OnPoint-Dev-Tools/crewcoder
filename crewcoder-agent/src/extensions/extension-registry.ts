import fs from "node:fs/promises";
import path from "node:path";
import { readConfig, writeConfig } from "../core/config.js";
import { ensureCrewCoderHome } from "../core/crewcoder-home.js";
import { loadCrewCoderExtensions, validateExtensionManifest } from "./extension-loader.js";
import { getTrustTier, type TrustTier } from "../core/trust.js";
import type { LoadedCrewCoderExtension } from "./types.js";

export async function listEnabledExtensions(): Promise<LoadedCrewCoderExtension[]> {
  const config = readConfig();
  const loaded = await loadCrewCoderExtensions();
  return loaded.filter((extension) => !config.disabledExtensions.includes(extension.manifest.id));
}

export async function inspectExtension(id: string): Promise<LoadedCrewCoderExtension | undefined> {
  const loaded = await loadCrewCoderExtensions();
  return loaded.find((extension) => extension.manifest.id === id);
}

export function setExtensionEnabled(id: string, enabled: boolean): void {
  const config = readConfig();
  const disabled = new Set(config.disabledExtensions);
  if (enabled) disabled.delete(id);
  else disabled.add(id);
  writeConfig({ ...config, disabledExtensions: [...disabled].sort() });
}

export function setExtensionTrusted(id: string, trusted: boolean): void {
  setExtensionTrustTier(id, trusted ? "trusted" : "prompt-only");
}

export function setExtensionTrustTier(id: string, tier: TrustTier): void {
  const config = readConfig();
  const trustedSet = new Set(config.trustedExtensions);
  const sandboxedSet = new Set(config.sandboxedExtensions);
  trustedSet.delete(id);
  sandboxedSet.delete(id);
  if (tier === "trusted") trustedSet.add(id);
  else if (tier === "sandboxed") sandboxedSet.add(id);
  writeConfig({ ...config, trustedExtensions: [...trustedSet].sort(), sandboxedExtensions: [...sandboxedSet].sort() });
}

export function getExtensionTrustTier(id: string): TrustTier {
  return getTrustTier(readConfig(), id);
}

export async function validateExtensionPath(extensionPath: string): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const manifestPath = path.join(extensionPath, "crewcoder.extension.json");
  const warnings: string[] = [];
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    validateExtensionManifest(manifest, warnings);
    return { ok: true, errors: [], warnings };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)], warnings };
  }
}

export async function getExtensionDir(id: string): Promise<string> {
  const home = ensureCrewCoderHome();
  return path.join(home.extensionsDir, id);
}
