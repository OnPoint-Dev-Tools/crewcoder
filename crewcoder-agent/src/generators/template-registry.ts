import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { PluginKind } from "../core/types.js";
import { discoverCrewCodeRepo } from "../core/crewcode-repo.js";

export type TemplateInfo = { kind: PluginKind; templateName: string; sourcePath?: string; available: boolean; };
const kindToTemplateName: Record<PluginKind, string> = {
  "static-panel": "static-panel-template",
  "typescript-panel": "typescript-panel-template",
  "repo-indexer": "repo-radar",
  "workspace-writer": "handoff-pack",
  "mock-agent": "mock-agent-provider",
  "http-agent": "company-agent-http-adapter",
  "openai-agent": "openai-compatible-provider",
  "exec-agent": "github-copilot-cli-provider",
  "mcp": "mcp-server-template",
  "browser-action": "browser-docs-grabber",
  "git-lens": "git-risk-lens",
  "mission-widget": "mission-ci-widget"
};
export const supportedPluginKinds = Object.keys(kindToTemplateName) as PluginKind[];
export function getTemplateNameForKind(kind: PluginKind): string { return kindToTemplateName[kind]; }
export function listTemplates(startDir = process.cwd()): TemplateInfo[] {
  const repo = discoverCrewCodeRepo(startDir);
  return supportedPluginKinds.map((kind) => {
    const templateName = kindToTemplateName[kind];
    const sourcePath = repo.examplesPluginsPath ? path.join(repo.examplesPluginsPath, templateName) : undefined;
    return { kind, templateName, sourcePath, available: Boolean(sourcePath && fsSync.existsSync(sourcePath)) };
  });
}
export async function copyTemplateToPlugin(input: { id: string; kind: PluginKind; targetDir: string; startDir?: string; }): Promise<string[] | undefined> {
  const repo = discoverCrewCodeRepo(input.startDir ?? process.cwd());
  if (!repo.examplesPluginsPath) return undefined;
  const source = path.join(repo.examplesPluginsPath, getTemplateNameForKind(input.kind));
  try { if (!(await fs.stat(source)).isDirectory()) return undefined; } catch { return undefined; }
  await fs.mkdir(input.targetDir, { recursive: true });
  await copyDir(source, input.targetDir);
  await rewriteManifest(input.targetDir, input.id);
  return collectFiles(input.targetDir);
}
async function copyDir(source: string, target: string): Promise<void> {
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const from = path.join(source, entry.name); const to = path.join(target, entry.name);
    if (entry.isDirectory()) { await fs.mkdir(to, { recursive: true }); await copyDir(from, to); }
    else { await fs.mkdir(path.dirname(to), { recursive: true }); await fs.copyFile(from, to); }
  }
}
async function rewriteManifest(pluginDir: string, id: string): Promise<void> {
  const manifestPath = path.join(pluginDir, "crewcode.plugin.json");
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.id = id; manifest.name = titleFromId(id); manifest.version = manifest.version ?? "0.1.0";
    manifest.crewcode = { ...(manifest.crewcode ?? {}), apiVersion: "0.1" };
    if (typeof manifest.$schema === "string") manifest.$schema = "../../schemas/crewcode.plugin.schema.json";
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  } catch {}
}
async function collectFiles(pluginDir: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full); else files.push(path.relative(pluginDir, full));
    }
  }
  await walk(pluginDir); return files.sort();
}
function titleFromId(id: string): string { return id.split(/[-_\s]+/g).filter(Boolean).map((part) => (part[0]?.toUpperCase() ?? "") + part.slice(1)).join(" "); }
