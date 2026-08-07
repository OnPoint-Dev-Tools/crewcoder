import { spawn } from "node:child_process";
import type { ToolDefinition, JsonObjectSchema } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { readConfig } from "../core/config.js";
import { listEnabledExtensions } from "./extension-registry.js";
import type { LoadedCrewCoderExtension } from "./types.js";
import { createContext, loadTrustedCrewCoderExtensionRuntime, moduleToolName } from "./extension-runtime.js";
import type { CrewCoderExtToolDefinition } from "./api.js";
import { getExtensionCapabilities } from "../core/trust.js";
import { detectSandboxBackend, wrapArgvCommand, prepareSandboxNetwork, SANDBOX_UNAVAILABLE_MESSAGE, type SandboxPolicy, type SandboxBackend } from "../core/sandbox.js";
import { normalizeAllowedHosts } from "../core/network-policy.js";

type ExtensionToolOptions = { sandboxed?: boolean; allowedHosts?: string[] };

type ExtensionToolManifest = {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  category?: string;
  renderer?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  parameters?: JsonObjectSchema;
  timeoutMs?: number;
  isMutation?: boolean;
};

type ExtensionToolArgs = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

export async function loadTrustedExtensionTools(): Promise<ToolDefinition[]> {
  const config = readConfig();
  if (!config.allowExtensionTools) return [];
  const extensions = await listEnabledExtensions();
  // Command tools load for both `trusted` (full access) and `sandboxed` tiers.
  // Sandboxed-tier command tools run inside the OS-level sandbox; trusted run raw.
  const manifestTools = extensions.flatMap((extension) => {
    const caps = getExtensionCapabilities(config, extension.manifest.id);
    if (!caps.tools) return [];
    const allowedHosts = normalizeAllowedHosts(extension.manifest.permissions?.network?.allowedHosts);
    return extensionToolsFromManifest(extension, { sandboxed: caps.toolsSandboxed, allowedHosts });
  });
  // In-process module tools require full access; they cannot be sandboxed as subprocesses.
  const runtime = await loadTrustedCrewCoderExtensionRuntime();
  const moduleTools = runtime.tools.map((tool) => createModuleExtensionTool(tool.extensionId, tool));
  return [...manifestTools, ...moduleTools];
}

export function extensionToolsFromManifest(extension: LoadedCrewCoderExtension, options: ExtensionToolOptions = {}): ToolDefinition[] {
  return (extension.manifest.contributes?.tools ?? [])
    .filter((tool): tool is ExtensionToolManifest => typeof tool.command === "string" && tool.command.trim().length > 0)
    .map((tool) => createExtensionTool(extension, tool, options));
}

function createModuleExtensionTool(extensionId: string, tool: CrewCoderExtToolDefinition): ToolDefinition<ExtensionToolArgs> {
  return {
    name: moduleToolName(extensionId, tool.name),
    description: tool.description,
    parameters: tool.parameters ?? { type: "object", additionalProperties: true },
    executionMode: "sequential",
    isMutation: tool.isMutation !== false,
    parse(args) {
      return tool.prepareArguments?.(args) ?? args;
    },
    async execute(args, context, signal) {
      const result = await tool.execute(`extension_${extensionId}_${tool.name}_${Date.now()}`, args, signal, undefined, {
        ...createContext({ cwd: context.cwd, sessionId: context.sessionId }),
        toolContext: context
      });
      return {
        ...result,
        details: compactDetails({
          extensionId,
          toolId: tool.name,
          label: tool.label,
          icon: tool.icon,
          category: tool.category,
          renderer: tool.renderer,
          ...(result.details ?? {})
        })
      };
    }
  };
}

function createExtensionTool(extension: LoadedCrewCoderExtension, tool: ExtensionToolManifest, options: ExtensionToolOptions = {}): ToolDefinition<ExtensionToolArgs> {
  const extensionId = extension.manifest.id;
  const toolId = tool.id;
  const name = extensionToolName(extensionId, toolId);
  const timeoutMs = clampTimeout(tool.timeoutMs);
  const sandboxed = options.sandboxed === true;
  const allowedHosts = normalizeAllowedHosts(options.allowedHosts);
  return {
    name,
    description: tool.description ?? `[${extensionId}] ${tool.title}`,
    parameters: tool.parameters ?? { type: "object", additionalProperties: true },
    executionMode: "sequential",
    // Extension tools execute external code. Treat them as review-risk unless an
    // author explicitly declares the tool read-only and the user trusts it.
    isMutation: tool.isMutation !== false,
    parse(args) {
      return args;
    },
    async execute(args, context, signal) {
      const renderedArgs = (tool.args ?? []).map((arg) => renderTemplate(arg, args, context.cwd, context.sessionId));
      const renderedEnv = renderEnv(tool.env ?? {}, args, context.cwd, context.sessionId);
      const spawnTarget = resolveSpawnTarget(tool.command as string, renderedArgs, sandboxed, allowedHosts, context.cwd);
      // Sandboxed-tier tools with a host allowlist get a per-run filtering proxy.
      const network = spawnTarget.policy
        ? await prepareSandboxNetwork(spawnTarget.policy, spawnTarget.backend)
        : { env: {}, dispose: async () => {} };
      try {
        const result = await runExtensionCommand({
          command: spawnTarget.command,
          args: spawnTarget.args,
          cwd: context.cwd,
          env: { ...renderedEnv, ...network.env },
          timeoutMs,
          signal
        });
        return textResult(result.output, compactDetails({
          extensionId,
          toolId,
          label: tool.title,
          icon: tool.icon,
          category: tool.category,
          renderer: tool.renderer,
          command: tool.command,
          args: renderedArgs,
          sandboxed: spawnTarget.sandboxed,
          sandboxBackend: spawnTarget.sandboxed ? spawnTarget.backend : undefined,
          allowedHosts: sandboxed && allowedHosts.length ? allowedHosts : undefined,
          exitCode: result.exitCode,
          timedOut: result.timedOut
        }));
      } finally {
        await network.dispose();
      }
    }
  };
}

function resolveSpawnTarget(command: string, args: string[], sandboxed: boolean, allowedHosts: string[], cwd: string): { command: string; args: string[]; sandboxed: boolean; backend: SandboxBackend; policy?: SandboxPolicy } {
  if (!sandboxed) return { command, args, sandboxed: false, backend: "none" };
  const backend = detectSandboxBackend();
  const policy: SandboxPolicy = {
    enabled: true,
    workspaceDir: cwd,
    network: { mode: allowedHosts.length > 0 ? "open" : "none", allowedHosts }
  };
  const wrapped = wrapArgvCommand(command, args, policy, backend);
  // Fail closed: a sandboxed-tier extension tool must never run unsandboxed.
  if (!wrapped.sandboxed) throw new Error(SANDBOX_UNAVAILABLE_MESSAGE);
  return { command: wrapped.file, args: wrapped.args, sandboxed: true, backend: wrapped.backend, policy };
}

function compactDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined));
}

export function extensionToolName(extensionId: string, toolId: string): string {
  return `extension_${safeNamePart(extensionId)}_${safeNamePart(toolId)}`;
}

function safeNamePart(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "tool";
}

function clampTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value), 1_000), MAX_TIMEOUT_MS);
}

function renderTemplate(template: string, args: ExtensionToolArgs, cwd: string, sessionId: string): string {
  return template
    .replaceAll("{{cwd}}", cwd)
    .replaceAll("{{sessionId}}", sessionId)
    .replaceAll("{{json}}", JSON.stringify(args))
    .replaceAll("{{argsJson}}", JSON.stringify(args))
    .replace(/\{\{arg:([a-zA-Z0-9_.-]+)\}\}/g, (_match, key: string) => stringifyArgValue(readPath(args, key)));
}

function renderEnv(env: Record<string, string>, args: ExtensionToolArgs, cwd: string, sessionId: string): Record<string, string> {
  const rendered: Record<string, string> = {
    CREWCODER_EXTENSION_ARGS: JSON.stringify(args),
    CREWCODER_CWD: cwd,
    CREWCODER_SESSION_ID: sessionId
  };
  for (const [key, value] of Object.entries(env)) rendered[key] = renderTemplate(value, args, cwd, sessionId);
  return rendered;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[part];
  }, value);
}

function stringifyArgValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function runExtensionCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<{ output: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...input.env }
    });
    let output = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);
    const abort = () => child.kill("SIGTERM");
    input.signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 120_000) output = output.slice(-120_000);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 120_000) output = output.slice(-120_000);
    });
    child.on("error", (error) => {
      output += `\n${error.message}`;
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      resolve({ output: output.trim() || "(no output)", exitCode: code, timedOut });
    });
  });
}
