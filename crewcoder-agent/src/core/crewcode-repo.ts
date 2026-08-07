import fs from "node:fs";
import path from "node:path";

export type CrewCodeRepoInfo = {
  root?: string;
  examplesPluginsPath?: string;
  schemaPath?: string;
  pluginApiPath?: string;
  source: "cwd-search" | "env" | "default-path" | "not-found";
};

export function discoverCrewCodeRepo(startDir = process.cwd()): CrewCodeRepoInfo {
  const envRoot = process.env.CREWCODE_REPO_ROOT;
  if (envRoot) return buildInfo(path.resolve(envRoot), "env");

  const envTemplates = process.env.CREWCODE_PLUGIN_TEMPLATES_DIR;
  if (envTemplates) {
    const resolved = path.resolve(envTemplates);
    return { root: path.dirname(path.dirname(resolved)), examplesPluginsPath: resolved, source: "env" };
  }

  const found = findUp(startDir, (dir) => fs.existsSync(path.join(dir, "examples", "plugins")) || fs.existsSync(path.join(dir, "schemas", "crewcode.plugin.schema.json")));
  if (found) return buildInfo(found, "cwd-search");

  if (fs.existsSync("/CrewCode/examples/plugins")) return buildInfo("/CrewCode", "default-path");
  return { source: "not-found" };
}

function buildInfo(root: string, source: CrewCodeRepoInfo["source"]): CrewCodeRepoInfo {
  const examplesPluginsPath = path.join(root, "examples", "plugins");
  const schemaPath = path.join(root, "schemas", "crewcode.plugin.schema.json");
  const pluginApiPath = path.join(root, "crewcoder", "crewcode-plugin-api");
  return {
    root,
    examplesPluginsPath: fs.existsSync(examplesPluginsPath) ? examplesPluginsPath : undefined,
    schemaPath: fs.existsSync(schemaPath) ? schemaPath : undefined,
    pluginApiPath: fs.existsSync(pluginApiPath) ? pluginApiPath : undefined,
    source
  };
}
function findUp(startDir: string, predicate: (dir: string) => boolean): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    if (predicate(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
