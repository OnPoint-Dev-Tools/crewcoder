import fs from "node:fs/promises";
import path from "node:path";
import type { PluginKind } from "../core/types.js";
import { copyTemplateToPlugin, supportedPluginKinds } from "./template-registry.js";

export function isSupportedPluginKind(kind: string): kind is PluginKind { return (supportedPluginKinds as string[]).includes(kind); }
export async function createPlugin(id: string, kind: PluginKind, targetRoot: string): Promise<string[]> {
  const dir = path.resolve(targetRoot, id); await fs.mkdir(dir, { recursive: true });
  const copied = await copyTemplateToPlugin({ id, kind, targetDir: dir, startDir: targetRoot });
  if (copied) return copied;
  if (kind === "static-panel") return createPanelPlugin(id, dir, ["workspace:read"], { tabs: [{ id: "main", title: titleFromId(id), icon: "grid", entry: "panel.html", singleton: true }] }, "Static panel plugin starter.");
  if (kind === "typescript-panel") return createTypescriptPanelPlugin(id, dir);
  if (kind === "repo-indexer") return createPanelPlugin(id, dir, ["workspace:read"], { tabs: [{ id: "main", title: titleFromId(id), icon: "search", entry: "panel.html", singleton: true }], sidebarPanels: [{ id: "main", title: titleFromId(id), icon: "search", entry: "panel.html" }], statusItems: [{ id: "ready", title: titleFromId(id), text: "index", icon: "search", sidebarPanel: "main" }] }, "Repo indexer starter.");
  if (kind === "workspace-writer") return createPanelPlugin(id, dir, ["workspace:read", "workspace:write"], { chatHeaderItems: [{ id: "main", title: titleFromId(id), icon: "file-plus", sidebarPanel: "main" }], sidebarPanels: [{ id: "main", title: titleFromId(id), icon: "file-plus", entry: "panel.html" }] }, "Workspace writer starter.");
  if (kind === "mock-agent") return createProviderPlugin(id, dir, "mock", ["agent:provider"], {});
  if (kind === "exec-agent") return createProviderPlugin(id, dir, "exec", ["agent:provider", "terminal:spawn"], { command: "echo", args: ["{{prompt}}"] });
  if (kind === "http-agent") return createProviderPlugin(id, dir, "http", ["agent:provider", "network:fetch"], { endpoint: "http://localhost:8787/agent" });
  if (kind === "openai-agent") return createProviderPlugin(id, dir, "openai-compatible", ["agent:provider", "network:fetch"], { endpoint: "http://localhost:1234/v1/chat/completions", apiKeyEnv: "OPENAI_API_KEY" });
  if (kind === "mcp") return createMcpPlugin(id, dir);
  if (kind === "browser-action") return createPanelPlugin(id, dir, [], { browserActions: [{ id: "main", title: titleFromId(id), icon: "book-open", sidebarPanel: "main" }], sidebarPanels: [{ id: "main", title: titleFromId(id), icon: "book-open", entry: "panel.html" }] }, "Browser action plugin starter.");
  if (kind === "git-lens") return createPanelPlugin(id, dir, [], { gitLenses: [{ id: "main", title: titleFromId(id), icon: "git-branch", sidebarPanel: "main" }], sidebarPanels: [{ id: "main", title: titleFromId(id), icon: "git-branch", entry: "panel.html" }] }, "Git lens plugin starter.");
  if (kind === "mission-widget") return createPanelPlugin(id, dir, [], { missionWidgets: [{ id: "main", title: titleFromId(id), icon: "activity", entry: "panel.html" }] }, "Mission widget plugin starter.");
  throw new Error(`Unsupported plugin kind: ${kind}`);
}
function titleFromId(id: string): string { return id.split(/[-_\s]+/g).filter(Boolean).map((part) => (part[0]?.toUpperCase() ?? "") + part.slice(1)).join(" "); }
function baseManifest(id: string, permissions: string[], contributes: Record<string, unknown>) { return { "$schema": "../../schemas/crewcode.plugin.schema.json", id, name: titleFromId(id), version: "0.1.0", crewcode: { apiVersion: "0.1" }, permissions, contributes }; }
async function writeJson(file: string, value: unknown): Promise<void> { await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8"); }
async function createPanelPlugin(id: string, dir: string, permissions: string[], contributes: Record<string, unknown>, description: string): Promise<string[]> {
  await writeJson(path.join(dir, "crewcode.plugin.json"), baseManifest(id, permissions, contributes));
  await fs.writeFile(path.join(dir, "panel.html"), `<!doctype html><html><head><meta charset="utf-8"/><title>${titleFromId(id)}</title><link rel="stylesheet" href="./style.css"/></head><body><main><h1>${titleFromId(id)}</h1><p>${description}</p><pre id="output"></pre></main><script src="./crewcode-plugin-api.js"></script><script src="./plugin.js"></script></body></html>\n`, "utf8");
  await fs.writeFile(path.join(dir, "style.css"), "body{margin:0;font-family:system-ui,sans-serif;background:#111827;color:#f9fafb}main{padding:16px}pre{white-space:pre-wrap}\n", "utf8");
  await writeBrowserApiPlaceholder(dir);
  await fs.writeFile(path.join(dir, "plugin.js"), "const output=document.querySelector('#output');window.crewcode?.onContext?.((ctx)=>{output.textContent=JSON.stringify(ctx,null,2);});\n", "utf8");
  await writeReadme(dir, titleFromId(id), [description, "Plugin UI runs in a sandboxed iframe. Do not use window.electronAPI."]);
  return ["crewcode.plugin.json", "panel.html", "plugin.js", "style.css", "crewcode-plugin-api.js", "README.md"];
}
async function createTypescriptPanelPlugin(id: string, dir: string): Promise<string[]> {
  await writeJson(path.join(dir, "crewcode.plugin.json"), baseManifest(id, ["workspace:read"], { tabs: [{ id: "main", title: titleFromId(id), icon: "grid", entry: "compiled/src/panel.html", singleton: true }] }));
  await fs.mkdir(path.join(dir, "src"), { recursive: true }); await fs.mkdir(path.join(dir, "compiled", "src"), { recursive: true }); await fs.mkdir(path.join(dir, "compiled", "assets"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "main.ts"), "import { crewcode } from 'crewcode-plugin-api';\ncrewcode.onContext((ctx)=>console.log(ctx));\n", "utf8");
  await fs.writeFile(path.join(dir, "compiled", "src", "panel.html"), `<!doctype html><html><body><pre id="root">Compiled placeholder for ${titleFromId(id)}</pre><script type="module" src="../assets/index.js"></script></body></html>\n`, "utf8");
  await fs.writeFile(path.join(dir, "compiled", "assets", "index.js"), "document.querySelector('#root').textContent='Compiled placeholder. Replace by running the template build.';\n", "utf8");
  await writeReadme(dir, titleFromId(id), ["TypeScript panel plugin fallback.", "CrewCoder prefers /CrewCode/examples/plugins/typescript-panel-template when available."]);
  return ["crewcode.plugin.json", "src/main.ts", "compiled/src/panel.html", "compiled/assets/index.js", "README.md"];
}
async function createProviderPlugin(id: string, dir: string, runtime: string, permissions: string[], extra: Record<string, unknown>): Promise<string[]> {
  await writeJson(path.join(dir, "crewcode.plugin.json"), baseManifest(id, permissions, { agentProviders: [{ id: "main", title: titleFromId(id), runtime, models: ["default"], ...extra }] }));
  await writeReadme(dir, titleFromId(id), [`CrewCode ${runtime} agent provider plugin.`, "CrewCode owns provider bridge lifecycle."]);
  return ["crewcode.plugin.json", "README.md"];
}
async function createMcpPlugin(id: string, dir: string): Promise<string[]> {
  await writeJson(path.join(dir, "crewcode.plugin.json"), baseManifest(id, ["mcp:server"], { mcpServers: [{ id: "main", title: titleFromId(id), command: "node", args: ["./server.js"], category: "tools" }] }));
  await fs.writeFile(path.join(dir, "server.js"), "#!/usr/bin/env node\nprocess.stdin.resume();\n", "utf8");
  await writeReadme(dir, titleFromId(id), ["CrewCode MCP server declaration plugin.", "CrewCode owns MCP lifecycle and approval."]);
  return ["crewcode.plugin.json", "server.js", "README.md"];
}
async function writeBrowserApiPlaceholder(dir: string): Promise<void> { await fs.writeFile(path.join(dir, "crewcode-plugin-api.js"), "window.crewcode=window.crewcode||{workspace:{async listFiles(){throw new Error('crewcode-plugin-api helper is not installed.')},async readFile(){throw new Error('crewcode-plugin-api helper is not installed.')},async writeFile(){throw new Error('crewcode-plugin-api helper is not installed.')}},onContext(handler){handler({})}};\n", "utf8"); }
async function writeReadme(dir: string, name: string, lines: string[]): Promise<void> { await fs.writeFile(path.join(dir, "README.md"), `# ${name}\n\n${lines.join("\n\n")}\n\n## Install\n\nCopy this folder to ~/.crewcode/plugins and approve it in CrewCode Settings → Plugins.\n`, "utf8"); }
