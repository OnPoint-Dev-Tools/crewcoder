import { readConfig } from "../core/config.js";
import { listEnabledExtensions } from "./extension-registry.js";
import type { LoadedCrewCoderExtension } from "./types.js";

export type CrewCoderExtensionRendererMatch = {
  extensionId?: string;
  toolId?: string;
  renderer?: string;
  toolName?: string;
};

export type CrewCoderExtensionRenderer = {
  extensionId: string;
  id: string;
  title: string;
  target: "tool";
  match: CrewCoderExtensionRendererMatch;
  template: string;
};

export function extensionRenderersFromManifest(extension: LoadedCrewCoderExtension): CrewCoderExtensionRenderer[] {
  return (extension.manifest.contributes?.ui ?? []).flatMap((item) => {
    if (item.kind !== "renderer" || item.target !== "tool" || typeof item.template !== "string") return [];
    const match = rendererMatch(item.match);
    if (!match) return [];
    return [{
      extensionId: extension.manifest.id,
      id: item.id,
      title: item.title,
      target: "tool" as const,
      match,
      template: item.template
    }];
  });
}

export async function listTrustedExtensionRenderers(): Promise<CrewCoderExtensionRenderer[]> {
  const config = readConfig();
  if (!config.allowExtensionModules) return [];
  const trusted = new Set(config.trustedExtensions);
  if (trusted.size === 0) return [];
  const extensions = await listEnabledExtensions();
  return extensions
    .filter((extension) => trusted.has(extension.manifest.id))
    .flatMap(extensionRenderersFromManifest);
}

function rendererMatch(value: unknown): CrewCoderExtensionRendererMatch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const match: CrewCoderExtensionRendererMatch = {};
  if (typeof record.extensionId === "string" && record.extensionId.trim()) match.extensionId = record.extensionId.trim();
  if (typeof record.toolId === "string" && record.toolId.trim()) match.toolId = record.toolId.trim();
  if (typeof record.renderer === "string" && record.renderer.trim()) match.renderer = record.renderer.trim();
  if (typeof record.toolName === "string" && record.toolName.trim()) match.toolName = record.toolName.trim();
  return Object.keys(match).length ? match : undefined;
}
