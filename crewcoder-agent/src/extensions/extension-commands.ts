import fs from "node:fs/promises";
import path from "node:path";
import type { StoredPromptCommand } from "../core/prompt-command-store.js";
import { getPromptCommand, listPromptCommands, normalizePromptCommandName } from "../core/prompt-command-store.js";
import { listEnabledExtensions } from "./extension-registry.js";
import type { LoadedCrewCoderExtension } from "./types.js";
import { createCommandContext, loadTrustedCrewCoderExtensionRuntime } from "./extension-runtime.js";
import type { ExtensionUiBridge } from "../core/extension-ui-bridge.js";
import type { CrewCoderExtUI } from "./api.js";

export type PromptCommandArgument = {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
};

type ExtensionCommandContribution = {
  id: string;
  title: string;
  description?: string;
  content?: string;
  file?: string;
  arguments?: PromptCommandArgument[];
};

export type AvailablePromptCommand = StoredPromptCommand & {
  source: "local" | "extension";
  extensionId?: string;
  title?: string;
  description?: string;
  arguments?: PromptCommandArgument[];
  missingArguments?: string[];
};

export type PromptCommandArgs = Record<string, string>;

export async function listAvailablePromptCommands(): Promise<AvailablePromptCommand[]> {
  const local = listPromptCommands().map((command): AvailablePromptCommand => ({ ...command, source: "local" }));
  const extension = await listExtensionPromptCommands();
  return [...local, ...extension].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAvailablePromptCommand(name: string, args: PromptCommandArgs = {}): Promise<AvailablePromptCommand> {
  const normalized = normalizePromptCommandName(name);
  try {
    return { ...getPromptCommand(normalized), source: "local" };
  } catch {
    const extension = (await listExtensionPromptCommands(args)).find((command) => command.name === normalized);
    if (extension) return extension;
    throw new Error(`Command not found: ${normalized}`);
  }
}

export function parsePromptCommandArgs(pairs: string[] = []): PromptCommandArgs {
  const parsed: PromptCommandArgs = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`Command args must use key=value syntax: ${pair}`);
    const key = pair.slice(0, eq).trim();
    if (!/^[a-zA-Z0-9_.-]+$/.test(key)) throw new Error(`Invalid command arg name: ${key}`);
    parsed[key] = pair.slice(eq + 1);
  }
  return parsed;
}

export async function listExtensionPromptCommands(args: PromptCommandArgs = {}): Promise<AvailablePromptCommand[]> {
  const extensions = await listEnabledExtensions();
  const commands: AvailablePromptCommand[] = [];
  for (const extension of extensions) {
    for (const contribution of extension.manifest.contributes?.commands ?? []) {
      const command = await resolveExtensionCommand(extension, contribution as ExtensionCommandContribution, args);
      if (command) commands.push(command);
    }
  }
  commands.push(...await listModulePromptCommands());
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

export type CommandNotification = {
  extensionId: string;
  message: string;
  level: "info" | "success" | "warning" | "error";
};

export type RunPromptCommandResult = {
  notifications: CommandNotification[];
};

export type RunPromptCommandOptions = {
  uiBridge?: ExtensionUiBridge;
  mode?: "tui" | "json" | "print";
};

export async function runAvailablePromptCommand(name: string, args: string, cwd = process.cwd(), options: RunPromptCommandOptions = {}): Promise<RunPromptCommandResult> {
  const normalized = normalizePromptCommandName(name);
  const runtime = await loadTrustedCrewCoderExtensionRuntime();
  const command = runtime.commands.find((item) => extensionCommandName(item.extensionId, item.name) === normalized);
  if (!command) throw new Error(`Executable extension command not found: ${normalized}`);
  const notifications: CommandNotification[] = [];
  const ui = options.uiBridge?.uiFor(command.extensionId) ?? createCollectingCommandUi(command.extensionId, notifications);
  const mode = options.mode ?? (options.uiBridge ? "tui" : "print");
  await command.handler(args, createCommandContext({ cwd, mode, hasUI: Boolean(options.uiBridge), ui }, runtime, command.extensionId));
  return { notifications };
}

export function extensionCommandName(extensionId: string, commandId: string): string {
  return normalizePromptCommandName(`ext.${safeNamePart(extensionId)}.${safeNamePart(commandId)}`);
}

async function listModulePromptCommands(): Promise<AvailablePromptCommand[]> {
  const runtime = await loadTrustedCrewCoderExtensionRuntime();
  return runtime.commands.map((command) => {
    const name = extensionCommandName(command.extensionId, command.name);
    return {
      name,
      path: `<extension:${command.extensionId}>`,
      content: `/${name}\n`,
      source: "extension" as const,
      extensionId: command.extensionId,
      title: command.name,
      description: command.description,
      arguments: []
    };
  });
}

async function resolveExtensionCommand(extension: LoadedCrewCoderExtension, contribution: ExtensionCommandContribution, args: PromptCommandArgs): Promise<AvailablePromptCommand | undefined> {
  const content = typeof contribution.content === "string"
    ? contribution.content
    : contribution.file
      ? await readExtensionCommandFile(extension.dir, contribution.file)
      : undefined;
  if (!content?.trim()) return undefined;
  const name = extensionCommandName(extension.manifest.id, contribution.id);
  const rendered = renderCommandContent(content, contribution.arguments ?? [], args);
  return {
    name,
    path: contribution.file ? path.join(extension.dir, contribution.file) : path.join(extension.dir, "crewcoder.extension.json"),
    content: rendered.content.endsWith("\n") ? rendered.content : `${rendered.content}\n`,
    source: "extension",
    extensionId: extension.manifest.id,
    title: contribution.title,
    description: contribution.description,
    arguments: contribution.arguments ?? [],
    missingArguments: rendered.missingArguments
  };
}

async function readExtensionCommandFile(extensionDir: string, file: string): Promise<string | undefined> {
  const resolved = path.resolve(extensionDir, file);
  if (resolved !== extensionDir && !resolved.startsWith(extensionDir + path.sep)) return undefined;
  try {
    return await fs.readFile(resolved, "utf8");
  } catch {
    return undefined;
  }
}

function renderCommandContent(content: string, argumentDefs: PromptCommandArgument[], provided: PromptCommandArgs): { content: string; missingArguments: string[] } {
  const defs = new Map(argumentDefs.map((arg) => [arg.name, arg]));
  const values = new Map<string, string>();
  for (const arg of argumentDefs) {
    if (provided[arg.name] !== undefined) values.set(arg.name, provided[arg.name] as string);
    else if (arg.default !== undefined) values.set(arg.name, arg.default);
  }

  const used = new Set<string>();
  const rendered = content.replace(/\{\{(?:arg:)?([a-zA-Z0-9_.-]+)\}\}/g, (match, key: string) => {
    used.add(key);
    const value = values.get(key);
    return value === undefined ? match : value;
  });

  const missing = new Set<string>();
  for (const arg of argumentDefs) {
    if (arg.required && !values.has(arg.name)) missing.add(arg.name);
  }
  for (const key of used) {
    const def = defs.get(key);
    if (def?.required && !values.has(key)) missing.add(key);
  }

  return { content: rendered, missingArguments: [...missing].sort() };
}

function createCollectingCommandUi(extensionId: string, notifications: CommandNotification[]): CrewCoderExtUI {
  return {
    notify(message, level = "info") {
      notifications.push({ extensionId, message, level });
    },
    async confirm() {
      return false;
    },
    async input(_title, options) {
      return options?.defaultValue;
    },
    async select<T extends string>(_title: string, options: T[] | Array<{ label: string; value: T; description?: string }>): Promise<T | undefined> {
      const first = options[0] as T | { value: T } | undefined;
      return typeof first === "string" ? first : first?.value;
    },
    async component(_title, component, options) {
      if (options?.actions?.length) return options.actions[0]?.id;
      if (component.kind === "actionList") return component.actions[0]?.id;
      return undefined;
    }
  };
}

function safeNamePart(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return safe || "command";
}
