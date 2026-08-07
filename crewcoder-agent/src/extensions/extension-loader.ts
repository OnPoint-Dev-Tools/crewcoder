import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { ensureCrewCoderHome } from "../core/crewcoder-home.js";
import { evaluateLiveUiGate } from "./extension-live-ui.js";
import type { LoadedCrewCoderExtension, CrewCoderExtensionManifest } from "./types.js";
import type { ProviderDefinition } from "../providers/types.js";
import { defaultProviderTransport, validateProviderTransport } from "../providers/provider-transport.js";
import { isHostAllowed } from "../core/network-policy.js";

const manifestName = "crewcoder.extension.json";

export async function loadCrewCoderExtensions(): Promise<LoadedCrewCoderExtension[]> {
  const home = ensureCrewCoderHome();
  await fs.mkdir(home.extensionsDir, { recursive: true });
  const loaded: LoadedCrewCoderExtension[] = [];
  const entries = await fs.readdir(home.extensionsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(home.extensionsDir, entry.name);
    const manifestPath = path.join(dir, manifestName);
    if (!fsSync.existsSync(manifestPath)) continue;
    const warnings: string[] = [];
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as CrewCoderExtensionManifest;
      validateExtensionManifest(manifest, warnings);
      loaded.push({ dir, manifest, warnings });
    } catch (error) {
      loaded.push({
        dir,
        manifest: { id: entry.name, name: entry.name, version: "0.0.0", crewcoder: { apiVersion: "0.1" } },
        warnings: [error instanceof Error ? error.message : String(error)]
      });
    }
  }
  return loaded;
}

export function providersFromExtensions(extensions: LoadedCrewCoderExtension[]): ProviderDefinition[] {
  return extensions.flatMap((extension) =>
    (extension.manifest.contributes?.providers ?? []).map((provider) => ({
      ...provider,
      kind: "extension" as const,
      extensionId: extension.manifest.id
    }))
  );
}

export function validateExtensionManifest(manifest: CrewCoderExtensionManifest, warnings: string[] = []): void {
  if (!manifest.id) throw new Error("CrewCoder extension manifest is missing id");
  if (!manifest.name) throw new Error(`CrewCoder extension ${manifest.id} is missing name`);
  if (!manifest.version) throw new Error(`CrewCoder extension ${manifest.id} is missing version`);
  if (manifest.crewcoder?.apiVersion !== "0.1") throw new Error(`CrewCoder extension ${manifest.id} must use crewcoder.apiVersion 0.1`);
  if (manifest.main !== undefined && typeof manifest.main !== "string") throw new Error(`Extension ${manifest.id} main must be a string`);
  validateExtensionPermissions(manifest.permissions, `Extension ${manifest.id} permissions`);
  validateStringArray(manifest.activation?.events, `Extension ${manifest.id} activation.events`);
  validateStringArray(manifest.activation?.keywords, `Extension ${manifest.id} activation.keywords`);
  validateStringArray(manifest.activation?.modes, `Extension ${manifest.id} activation.modes`);
  validateStringArray(manifest.activation?.commands, `Extension ${manifest.id} activation.commands`);
  validateStringArray(manifest.activation?.filePatterns, `Extension ${manifest.id} activation.filePatterns`);
  for (const provider of manifest.contributes?.providers ?? []) {
    if (!provider.id || !provider.command) throw new Error(`Extension ${manifest.id} has invalid provider contribution`);
    if (provider.runtime !== "process" && provider.runtime !== "model-command" && provider.runtime !== "claude-agent-sdk" && provider.runtime !== "anthropic-messages" && provider.runtime !== "openai-chat-completions" && provider.runtime !== "openai-responses" && provider.runtime !== "openai-codex-responses" && provider.runtime !== "websocket") throw new Error(`Extension ${manifest.id} provider ${provider.id} has unsupported runtime`);
    validateProviderTransport(provider.runtime, provider.transport ?? defaultProviderTransport(provider.runtime), "extension");
    const networkRuntime = provider.runtime === "anthropic-messages" || provider.runtime === "openai-chat-completions" || provider.runtime === "openai-responses" || provider.runtime === "websocket";
    if (networkRuntime && !provider.endpoint) throw new Error(`Extension ${manifest.id} provider ${provider.id} is missing endpoint`);
    if (networkRuntime && provider.endpoint) {
      let endpointHost: string;
      try { endpointHost = new URL(provider.endpoint).hostname; } catch { throw new Error(`Extension ${manifest.id} provider ${provider.id} has invalid endpoint`); }
      if (!isHostAllowed(endpointHost, manifest.permissions?.network?.allowedHosts ?? [])) {
        throw new Error(`Extension ${manifest.id} provider ${provider.id} endpoint host ${endpointHost} is not declared in permissions.network.allowedHosts`);
      }
    }
    for (const arg of provider.args ?? []) {
      if (typeof arg !== "string") throw new Error(`Extension ${manifest.id} provider ${provider.id} has non-string args`);
    }
  }
  validateToolContributions(manifest.contributes?.tools, `Extension ${manifest.id} tools`);
  validateCommandContributions(manifest.contributes?.commands, `Extension ${manifest.id} commands`);
  validateWorkflowContributions(manifest.contributes?.workflows, `Extension ${manifest.id} workflows`);
  validateContributionArray(manifest.contributes?.contextProviders, `Extension ${manifest.id} contextProviders`);
  validateValidatorContributions(manifest.contributes?.validators, `Extension ${manifest.id} validators`);
  validateApprovalPolicyContributions(manifest.contributes?.approvalPolicies, `Extension ${manifest.id} approvalPolicies`);
  validateFileTriggerContributions(manifest.contributes?.fileTriggers, `Extension ${manifest.id} fileTriggers`);
  validateHookContributions(manifest.contributes?.hooks, `Extension ${manifest.id} hooks`);
  validateUiContributions(manifest.contributes?.ui, `Extension ${manifest.id} ui`);
  validateLiveUiContributions(manifest.contributes?.liveUi, `Extension ${manifest.id} liveUi`);
  if (manifest.main) warnings.push("Extension main modules run only when allowExtensionModules=true and the extension is trusted.");
  if (manifest.contributes?.tools?.length) warnings.push("Extension tools run only when allowExtensionTools=true and the extension is trusted.");
  if (manifest.contributes?.hooks?.length) warnings.push("Extension hooks run only when allowExtensionHooks=true and the extension is trusted.");
  if (manifest.contributes?.fileTriggers?.length) warnings.push("Extension file triggers run only when allowExtensionHooks=true and the extension is trusted.");
  if (manifest.contributes?.contextProviders?.length) warnings.push("Extension contextProviders are declared as contracts; CrewCoder does not execute this contribution point yet.");
  if (manifest.contributes?.workflows?.some((workflow) => workflow.steps.some((step) => step.kind === "tool"))) {
    warnings.push("Extension workflow tool steps run only when the extension is trusted or sandboxed.");
  }
  if (manifest.contributes?.approvalPolicies?.length) warnings.push("Extension approval policies run only when allowExtensionHooks=true and the extension is trusted.");
  if (manifest.contributes?.ui?.some((item) => item.kind === "renderer")) warnings.push("Extension renderers are used only by trusted TUI hosts when allowExtensionModules=true and the extension is trusted.");
  if (manifest.contributes?.ui?.some((item) => item.kind !== "renderer")) warnings.push("Extension custom UI components are declared as contracts; CrewCoder does not execute this contribution point yet.");
  for (const item of manifest.contributes?.liveUi ?? []) {
    const gate = evaluateLiveUiGate(item, { enabled: true, trusted: true, allowLiveUi: true });
    if (!gate.allowed) {
      warnings.push(`LiveUi "${item.id}": blocked — ${gate.blockedReasons.join("; ")}`);
    }
  }
  if (manifest.contributes?.liveUi?.length) warnings.push("Extension liveUi entries are experimental declared contracts; CrewCoder does not load live UI code yet.");
}

function validateExtensionPermissions(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const record = value as Record<string, unknown>;
  if (record.network !== undefined) {
    if (!record.network || typeof record.network !== "object" || Array.isArray(record.network)) throw new Error(`${label}.network must be an object`);
    const hosts = (record.network as Record<string, unknown>).allowedHosts;
    if (!Array.isArray(hosts) || hosts.some((host) => typeof host !== "string" || !host.trim())) throw new Error(`${label}.network.allowedHosts must be a non-empty array of host strings`);
  }
}

function validateStringArray(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} must be an array of strings`);
}

function validateContributionArray(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) validateContributionBasics(item, label);
}

const workflowGuardPattern = /^steps\.[A-Za-z0-9._-]+\.(ok|failed)$/;

function validateWorkflowContributions(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) {
    const record = validateContributionBasics(item, label);
    const steps = record.steps;
    if (!Array.isArray(steps) || steps.length === 0) throw new Error(`${label} ${String(record.id)} must declare a non-empty steps array`);
    const seen = new Set<string>();
    steps.forEach((step: unknown, index: number) => {
      const stepLabel = `${label} ${String(record.id)} step ${index + 1}`;
      if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`${stepLabel} must be an object`);
      const stepRecord = step as Record<string, unknown>;
      const kind = stepRecord.kind;
      if (kind !== "tool" && kind !== "prompt") throw new Error(`${stepLabel} kind must be "tool" or "prompt"`);
      if (stepRecord.id !== undefined) {
        if (typeof stepRecord.id !== "string" || !stepRecord.id.trim()) throw new Error(`${stepLabel} id must be a non-empty string`);
        if (seen.has(stepRecord.id)) throw new Error(`${stepLabel} reuses step id ${stepRecord.id}`);
        seen.add(stepRecord.id);
      }
      if (kind === "tool") {
        if (typeof stepRecord.tool !== "string" || !stepRecord.tool.trim()) throw new Error(`${stepLabel} must declare a tool name`);
        if (stepRecord.args !== undefined && (typeof stepRecord.args !== "object" || stepRecord.args === null || Array.isArray(stepRecord.args))) throw new Error(`${stepLabel} args must be an object`);
      } else {
        if (typeof stepRecord.prompt !== "string" || !stepRecord.prompt.trim()) throw new Error(`${stepLabel} must declare a prompt`);
        validateStringArray(stepRecord.allowTools, `${stepLabel} allowTools`);
      }
      if (stepRecord.title !== undefined && typeof stepRecord.title !== "string") throw new Error(`${stepLabel} title must be a string`);
      if (stepRecord.when !== undefined && (typeof stepRecord.when !== "string" || !workflowGuardPattern.test(stepRecord.when))) {
        throw new Error(`${stepLabel} when must look like steps.<id>.ok or steps.<id>.failed`);
      }
      if (stepRecord.onFailure !== undefined && stepRecord.onFailure !== "stop" && stepRecord.onFailure !== "continue") {
        throw new Error(`${stepLabel} onFailure must be "stop" or "continue"`);
      }
    });
  }
}

function validateValidatorContributions(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) {
    const record = validateContributionBasics(item, label);
    if (record.command !== undefined && typeof record.command !== "string") throw new Error(`${label} command must be a string`);
    if (record.args !== undefined && (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== "string"))) throw new Error(`${label} args must be an array of strings`);
    if (record.timeoutMs !== undefined && typeof record.timeoutMs !== "number") throw new Error(`${label} timeoutMs must be a number`);
  }
}

function validateToolContributions(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) {
    const record = validateContributionBasics(item, label);
    if (record.command !== undefined && typeof record.command !== "string") throw new Error(`${label} command must be a string`);
    if (record.args !== undefined && (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== "string"))) throw new Error(`${label} args must be an array of strings`);
    if (record.env !== undefined && (!record.env || typeof record.env !== "object" || Array.isArray(record.env) || Object.values(record.env).some((value) => typeof value !== "string"))) throw new Error(`${label} env must be an object of strings`);
    if (record.icon !== undefined && typeof record.icon !== "string") throw new Error(`${label} icon must be a string`);
    if (record.category !== undefined && typeof record.category !== "string") throw new Error(`${label} category must be a string`);
    if (record.renderer !== undefined && typeof record.renderer !== "string") throw new Error(`${label} renderer must be a string`);
    if (record.timeoutMs !== undefined && typeof record.timeoutMs !== "number") throw new Error(`${label} timeoutMs must be a number`);
    if (record.isMutation !== undefined && typeof record.isMutation !== "boolean") throw new Error(`${label} isMutation must be a boolean`);
  }
}

function validateCommandContributions(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) {
    const record = validateContributionBasics(item, label);
    if (record.content !== undefined && typeof record.content !== "string") throw new Error(`${label} content must be a string`);
    if (record.file !== undefined && typeof record.file !== "string") throw new Error(`${label} file must be a string`);
    if (record.arguments !== undefined) validateCommandArguments(record.arguments, label);
  }
}

function validateApprovalPolicyContributions(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) {
    const record = validateContributionBasics(item, label);
    if (record.action !== undefined && !["allow", "review", "block"].includes(String(record.action))) throw new Error(`${label} action must be one of: allow, review, block`);
    validateStringArray(record.tools, `${label} tools`);
    validateStringArray(record.paths, `${label} paths`);
    validateStringArray(record.commands, `${label} commands`);
    if (record.reason !== undefined && typeof record.reason !== "string") throw new Error(`${label} reason must be a string`);
  }
}

function validateFileTriggerContributions(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) {
    const record = validateContributionBasics(item, label);
    if (!Array.isArray(record.patterns) || record.patterns.length === 0 || record.patterns.some((pattern) => typeof pattern !== "string" || !pattern.trim())) throw new Error(`${label} patterns must be a non-empty array of strings`);
    if (typeof record.command !== "string" || !record.command.trim()) throw new Error(`${label} command must be a non-empty string`);
    if (record.args !== undefined && (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== "string"))) throw new Error(`${label} args must be an array of strings`);
    if (record.env !== undefined && (!record.env || typeof record.env !== "object" || Array.isArray(record.env) || Object.values(record.env).some((env) => typeof env !== "string"))) throw new Error(`${label} env must be an object of strings`);
    if (record.timeoutMs !== undefined && typeof record.timeoutMs !== "number") throw new Error(`${label} timeoutMs must be a number`);
  }
}

function validateHookContributions(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) {
    const record = validateContributionBasics(item, label);
    if (record.event !== undefined && !["context", "beforeToolCall", "afterToolCall", "onError", "compaction"].includes(String(record.event))) throw new Error(`${label} event must be one of: context, beforeToolCall, afterToolCall, onError, compaction`);
    if (record.matches !== undefined) {
      if (!record.matches || typeof record.matches !== "object" || Array.isArray(record.matches)) throw new Error(`${label} matches must be an object`);
      const matches = record.matches as Record<string, unknown>;
      validateStringArray(matches.tools, `${label} matches.tools`);
      validateStringArray(matches.paths, `${label} matches.paths`);
      validateStringArray(matches.commands, `${label} matches.commands`);
    }
    if (record.command !== undefined && typeof record.command !== "string") throw new Error(`${label} command must be a string`);
    if (record.args !== undefined && (!Array.isArray(record.args) || record.args.some((arg) => typeof arg !== "string"))) throw new Error(`${label} args must be an array of strings`);
    if (record.env !== undefined && (!record.env || typeof record.env !== "object" || Array.isArray(record.env) || Object.values(record.env).some((env) => typeof env !== "string"))) throw new Error(`${label} env must be an object of strings`);
    if (record.timeoutMs !== undefined && typeof record.timeoutMs !== "number") throw new Error(`${label} timeoutMs must be a number`);
  }
}

function validateUiContributions(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) {
    const record = validateContributionBasics(item, label);
    if (record.kind !== "renderer") continue;
    if (record.target !== "tool") throw new Error(`${label} renderer target must be tool`);
    if (typeof record.template !== "string" || !record.template.trim()) throw new Error(`${label} renderer template must be a non-empty string`);
    if (!record.match || typeof record.match !== "object" || Array.isArray(record.match)) throw new Error(`${label} renderer match must be an object`);
    const match = record.match as Record<string, unknown>;
    const supported = ["extensionId", "toolId", "renderer", "toolName"];
    const hasMatcher = supported.some((key) => typeof match[key] === "string" && String(match[key]).trim());
    if (!hasMatcher) throw new Error(`${label} renderer match must include extensionId, toolId, renderer, or toolName`);
    for (const key of supported) {
      if (match[key] !== undefined && typeof match[key] !== "string") throw new Error(`${label} renderer match.${key} must be a string`);
    }
  }
}

function validateLiveUiContributions(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  for (const item of value) {
    const record = validateContributionBasics(item, label);
    if (!/^[a-zA-Z0-9_.-]+$/.test(String(record.id))) throw new Error(`${label} id must use letters, numbers, dots, underscores, or dashes`);
    if (record.experimental !== true) throw new Error(`${label} entries must set experimental true`);
    if (typeof record.entry !== "string" || !record.entry.trim()) throw new Error(`${label} entry must be a non-empty string`);
    if (path.isAbsolute(record.entry) || record.entry.split(/[\\/]+/).includes("..")) throw new Error(`${label} entry must stay inside the extension directory`);
    if (!record.target || typeof record.target !== "object" || Array.isArray(record.target)) throw new Error(`${label} target must be an object`);
    const target = record.target as Record<string, unknown>;
    if (target.surface !== "modal" && target.surface !== "transcript" && target.surface !== "status") throw new Error(`${label} target.surface must be one of: modal, transcript, status`);
    if (target.slot !== undefined && typeof target.slot !== "string") throw new Error(`${label} target.slot must be a string`);
    validateLiveUiActivation(record.activation, label);
    validateLiveUiMatch(record.match, label);
    if (!record.permissions || typeof record.permissions !== "object" || Array.isArray(record.permissions)) throw new Error(`${label} permissions must be an object`);
    validateLiveUiPermissions(record.permissions as Record<string, unknown>, label);
  }
}

function validateLiveUiActivation(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} activation must be an object`);
  const record = value as Record<string, unknown>;
  validateStringArray(record.events, `${label} activation.events`);
  validateStringArray(record.commands, `${label} activation.commands`);
  validateStringArray(record.filePatterns, `${label} activation.filePatterns`);
  validateStringEnumArray(record.modes, `${label} activation.modes`, ["tui"]);
}

function validateLiveUiMatch(value: unknown, label: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} match must be an object`);
  const record = value as Record<string, unknown>;
  const keys = ["eventTypes", "toolNames", "extensionIds", "toolIds", "renderers", "uiKinds", "componentKinds"];
  for (const key of ["eventTypes", "toolNames", "extensionIds", "toolIds", "renderers"] as const) validateStringArray(record[key], `${label} match.${key}`);
  validateStringEnumArray(record.uiKinds, `${label} match.uiKinds`, ["confirm", "input", "select", "component"]);
  validateStringEnumArray(record.componentKinds, `${label} match.componentKinds`, ["markdown", "details", "table", "actionList"]);
  const hasMatcher = keys.some((key) => Array.isArray(record[key]) && (record[key] as unknown[]).length > 0);
  if (!hasMatcher) throw new Error(`${label} match must include at least one matcher`);
}

function validateLiveUiPermissions(permissions: Record<string, unknown>, label: string): void {
  validateStringEnumArray(permissions.ui, `${label} permissions.ui`, ["render", "input", "focus"]);
  const ui = permissions.ui as unknown[] | undefined;
  if (!Array.isArray(ui) || !ui.includes("render")) throw new Error(`${label} permissions.ui must include render`);
  validateStringArray(permissions.events, `${label} permissions.events`);
  if (Array.isArray(permissions.events)) {
    for (const item of permissions.events) {
      const eventPermission = String(item);
      if (!eventPermission.startsWith("read:") || eventPermission.length <= "read:".length) throw new Error(`${label} permissions.events entries must start with read:`);
    }
  }
  validateStringArray(permissions.commands, `${label} permissions.commands`);
  if (Array.isArray(permissions.commands)) {
    for (const item of permissions.commands) {
      const commandPermission = String(item);
      if (commandPermission !== "ui_response" && !commandPermission.startsWith("ext.")) throw new Error(`${label} permissions.commands entries must be ui_response or ext.*`);
    }
  }
  if (permissions.clipboard !== undefined && permissions.clipboard !== "none" && permissions.clipboard !== "write" && permissions.clipboard !== "read") throw new Error(`${label} permissions.clipboard must be none, write, or read`);
  if (permissions.storage !== undefined && permissions.storage !== "none" && permissions.storage !== "session") throw new Error(`${label} permissions.storage must be none or session`);
  if (permissions.network !== undefined) {
    if (!permissions.network || typeof permissions.network !== "object" || Array.isArray(permissions.network)) throw new Error(`${label} permissions.network must be an object`);
    validateStringArray((permissions.network as Record<string, unknown>).allowedHosts, `${label} permissions.network.allowedHosts`);
  }
}

function validateStringEnumArray(value: unknown, label: string, allowed: string[]): void {
  validateStringArray(value, label);
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!allowed.includes(String(item))) throw new Error(`${label} must contain only: ${allowed.join(", ")}`);
  }
}

function validateCommandArguments(value: unknown, label: string): void {
  if (!Array.isArray(value)) throw new Error(`${label} arguments must be an array`);
  for (const item of value) {
    if (!item || typeof item !== "object") throw new Error(`${label} arguments entries must be objects`);
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(record.name)) throw new Error(`${label} argument name must use letters, numbers, dots, underscores, or dashes`);
    if (record.description !== undefined && typeof record.description !== "string") throw new Error(`${label} argument description must be a string`);
    if (record.required !== undefined && typeof record.required !== "boolean") throw new Error(`${label} argument required must be a boolean`);
    if (record.default !== undefined && typeof record.default !== "string") throw new Error(`${label} argument default must be a string`);
  }
}

function validateContributionBasics(item: unknown, label: string): Record<string, unknown> {
  if (!item || typeof item !== "object") throw new Error(`${label} entries must be objects`);
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string" || !record.id.trim()) throw new Error(`${label} entries must include id`);
  if (typeof record.title !== "string" || !record.title.trim()) throw new Error(`${label} entries must include title`);
  return record;
}
