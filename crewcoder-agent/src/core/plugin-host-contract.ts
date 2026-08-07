import fs from "node:fs";
import path from "node:path";

/**
 * A faithful port of CrewCode's v0 plugin capability layer
 * (`CrewCode/src/main/plugin-contract.ts`), with the Electron/IPC plumbing removed.
 *
 * This exists so `crewcoder plugin test` can answer "would the real host have
 * allowed this?" without running CrewCode. The permission gating and the **exact
 * error strings** are copied deliberately: a smoke test that denies a call for a
 * different reason than the real host, or with a different message, is worse than
 * no test, because it teaches plugin authors the wrong contract.
 *
 * If CrewCode's contract changes, this file changes with it.
 */

export type PluginPermission =
  | "workspace:read"
  | "workspace:write"
  | "git:read"
  | "git:write"
  | "terminal:spawn"
  | "terminal:read"
  | "agent:prompt"
  | "agent:provider"
  | "browser:read"
  | "mcp:server"
  | "network:fetch"
  | "secrets:read";

export type PluginInvokeMethod = "workspace:listFiles" | "workspace:readFile" | "workspace:writeFile" | "network:fetch" | "secrets:get";

export const PLUGIN_INVOKE_METHODS: PluginInvokeMethod[] = ["workspace:listFiles", "workspace:readFile", "workspace:writeFile", "network:fetch", "secrets:get"];

/** The permission each method requires, or null when the method is denied outright in v0. */
export const METHOD_PERMISSIONS: Record<PluginInvokeMethod, PluginPermission | null> = {
  "workspace:listFiles": "workspace:read",
  "workspace:readFile": "workspace:read",
  "workspace:writeFile": "workspace:write",
  "network:fetch": null,
  "secrets:get": null
};

export type PluginInvokeResult = { ok: true; result: unknown } | { ok: false; error: string };

export type PluginInvokeRequest = {
  method: string;
  params?: Record<string, unknown>;
  /** Permissions declared by the plugin manifest. */
  permissions: string[];
  /** Absolute workspace root the sandboxed host is rooted at. */
  workspaceRoot: string;
};

// Mirrors CrewCode/src/main/fs-constants.ts.
const IGNORE = new Set([".git", "node_modules", ".next", "out", "dist", ".DS_Store", ".cache", ".turbo"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LISTED_FILES = 5000;

export function invokePluginCapability(request: PluginInvokeRequest): PluginInvokeResult {
  const permissions = new Set(request.permissions);
  const method = request.method;

  if (method === "workspace:listFiles") {
    if (!permissions.has("workspace:read")) return permissionDenied(method, "workspace:read");
    return listWorkspaceFiles(request.workspaceRoot);
  }
  if (method === "workspace:readFile") {
    if (!permissions.has("workspace:read")) return permissionDenied(method, "workspace:read");
    const sub = request.params?.sub;
    if (typeof sub !== "string") return { ok: false, error: "params.sub required" };
    return readWorkspaceFile(request.workspaceRoot, sub);
  }
  if (method === "workspace:writeFile") {
    if (!permissions.has("workspace:write")) return permissionDenied(method, "workspace:write");
    const sub = request.params?.sub;
    const text = request.params?.text;
    if (typeof sub !== "string") return { ok: false, error: "params.sub required" };
    if (typeof text !== "string") return { ok: false, error: "params.text required" };
    return writeWorkspaceFile(request.workspaceRoot, sub, text);
  }
  // These two are denied for every plugin in v0 regardless of the manifest, which
  // is why declaring `network:fetch`/`secrets:read` does not unlock them.
  if (method === "network:fetch") {
    return { ok: false, error: "plugin capability denied: network:fetch is reserved for future audited host networking; provider runtimes are the v0 network path" };
  }
  if (method === "secrets:get") {
    return { ok: false, error: "plugin capability denied: secrets:get is reserved until first-class plugin secret storage exists" };
  }
  return { ok: false, error: `unsupported plugin method: ${String(method)}` };
}

export function isPluginInvokeMethod(value: string): value is PluginInvokeMethod {
  return (PLUGIN_INVOKE_METHODS as string[]).includes(value);
}

/** True when a method can never succeed in API v0, whatever the manifest declares. */
export function isAlwaysDeniedMethod(method: PluginInvokeMethod): boolean {
  return METHOD_PERMISSIONS[method] === null;
}

function permissionDenied(method: string, permission: PluginPermission): PluginInvokeResult {
  return { ok: false, error: `plugin capability denied: ${method} requires ${permission}` };
}

function listWorkspaceFiles(root: string): PluginInvokeResult {
  if (!root || !path.isAbsolute(root)) return { ok: false, error: "absolute workspace root required" };
  if (!fs.existsSync(root)) return { ok: false, error: "workspace root missing" };
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      if (IGNORE.has(name)) continue;
      const abs = path.join(dir, name);
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) walk(abs);
      else if (stat.isFile()) files.push(path.relative(root, abs));
      if (files.length >= MAX_LISTED_FILES) return;
    }
  };
  walk(root);
  return { ok: true, result: { files } };
}

function readWorkspaceFile(root: string, sub: string): PluginInvokeResult {
  if (!root || !path.isAbsolute(root)) return { ok: false, error: "absolute workspace root required" };
  const target = path.join(root, sub);
  if (!isSafePathUnder(root, target)) return { ok: false, error: "path escapes workspace" };
  if (!fs.existsSync(target)) return { ok: false, error: "file missing" };
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return { ok: false, error: "is a directory" };
  if (stat.size > MAX_FILE_BYTES) return { ok: false, error: "file too large (>2MB)" };
  return { ok: true, result: { text: fs.readFileSync(target, "utf8"), rel: sub, size: stat.size } };
}

function writeWorkspaceFile(root: string, sub: string, text: string): PluginInvokeResult {
  if (!root || !path.isAbsolute(root)) return { ok: false, error: "absolute workspace root required" };
  const target = path.join(root, sub);
  if (!isSafePathUnder(root, target)) return { ok: false, error: "path escapes workspace" };
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) return { ok: false, error: "file too large (>2MB)" };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text, "utf8");
    return { ok: true, result: { rel: sub } };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function isSafePathUnder(root: string, target: string): boolean {
  const a = path.normalize(root);
  const b = path.normalize(target);
  return b === a || b.startsWith(a + path.sep);
}
