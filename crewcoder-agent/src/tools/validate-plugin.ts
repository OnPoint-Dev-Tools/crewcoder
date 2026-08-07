import fs from "node:fs";
import path from "node:path";
import { SUPPORTED_CONTRIBUTION_POINTS, SUPPORTED_PROVIDER_RUNTIMES } from "../knowledge/constraints.js";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function validatePlugin(pluginDir: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const manifestPath = path.join(pluginDir, "crewcode.plugin.json");

  if (!fs.existsSync(manifestPath)) {
    return {
      ok: false,
      errors: ["Missing crewcode.plugin.json"],
      warnings
    };
  }

  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      errors: ["crewcode.plugin.json is not valid JSON"],
      warnings
    };
  }

  if (manifest.crewcode?.apiVersion !== "0.1") {
    errors.push('crewcode.apiVersion must be "0.1"');
  }

  if (!manifest.id || typeof manifest.id !== "string") {
    errors.push("manifest.id is required");
  }

  if (!manifest.name || typeof manifest.name !== "string") {
    errors.push("manifest.name is required");
  }

  const permissions = new Set<string>(Array.isArray(manifest.permissions) ? manifest.permissions : []);
  const contributes = manifest.contributes ?? {};

  for (const key of Object.keys(contributes)) {
    if (!SUPPORTED_CONTRIBUTION_POINTS.includes(key)) {
      errors.push(`Unsupported contribution point: ${key}`);
    }
  }

  validatePanelEntries(pluginDir, contributes.tabs, "tabs", errors);
  validatePanelEntries(pluginDir, contributes.sidebarPanels, "sidebarPanels", errors);

  if (Array.isArray(contributes.mcpServers) && !permissions.has("mcp:server")) {
    errors.push("contributes.mcpServers requires permission mcp:server");
  }

  if (Array.isArray(contributes.agentProviders)) {
    if (!permissions.has("agent:provider")) {
      errors.push("contributes.agentProviders requires permission agent:provider");
    }

    for (const provider of contributes.agentProviders) {
      if (!SUPPORTED_PROVIDER_RUNTIMES.includes(provider.runtime)) {
        errors.push(`Unsupported agent provider runtime: ${provider.runtime}`);
      }

      if (["exec", "stdio-jsonrpc"].includes(provider.runtime) && !permissions.has("terminal:spawn")) {
        errors.push(`runtime ${provider.runtime} requires permission terminal:spawn`);
      }

      if (["http", "sse-http", "openai-compatible", "websocket"].includes(provider.runtime) && !permissions.has("network:fetch")) {
        errors.push(`runtime ${provider.runtime} requires permission network:fetch`);
      }
    }
  }

  scanForForbiddenIframeApis(pluginDir, errors, warnings);

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}

function validatePanelEntries(pluginDir: string, entries: unknown, label: string, errors: string[]) {
  if (!Array.isArray(entries)) return;

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const panelEntry = (entry as any).entry;

    if (!panelEntry || typeof panelEntry !== "string") {
      errors.push(`${label} entry is missing entry path`);
      continue;
    }

    if (path.isAbsolute(panelEntry) || panelEntry.includes("..")) {
      errors.push(`${label} entry must be a relative path inside the plugin folder: ${panelEntry}`);
      continue;
    }

    if (!fs.existsSync(path.join(pluginDir, panelEntry))) {
      errors.push(`${label} entry file does not exist: ${panelEntry}`);
    }
  }
}

function scanForForbiddenIframeApis(pluginDir: string, errors: string[], warnings: string[]) {
  const forbidden = ["window.electronAPI", "secrets.get", "network.fetch"];
  const allowedExt = new Set([".js", ".ts", ".tsx", ".html"]);

  function walk(dir: string) {
    for (const item of fs.readdirSync(dir)) {
      const full = path.join(dir, item);
      const stat = fs.statSync(full);

      if (stat.isDirectory()) {
        if (["node_modules", "dist", ".git"].includes(item)) continue;
        walk(full);
        continue;
      }

      if (!allowedExt.has(path.extname(item))) continue;

      const text = fs.readFileSync(full, "utf8");
      for (const token of forbidden) {
        if (text.includes(token)) {
          errors.push(`Forbidden iframe API usage found in ${path.relative(pluginDir, full)}: ${token}`);
        }
      }

      if (text.includes("fetch(")) {
        warnings.push(`Review fetch usage in ${path.relative(pluginDir, full)}. Plugin iframes may not use CrewCode network capability routes.`);
      }
    }
  }

  walk(pluginDir);
}
