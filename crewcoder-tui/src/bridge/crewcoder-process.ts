import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCrewCoderEvent, type CrewCoderJsonEvent } from "./event-parser.js";
import { buildRemoteCrewCoderCommand, readCrewCoderRemoteConnection } from "./remote-connection.js";

export type CrewCoderApprovalMode = "never" | "review" | "always" | "full-access";

export type CrewCoderProcessOptions = {
  prompt: string;
  provider: string;
  mode: string;
  worker?: string;
  model?: string;
  systemPrompt?: string;
  effort?: string;
  cwd?: string;
  approval?: CrewCoderApprovalMode;
  parentSessionId?: string;
  images?: string[];
  externalDirectories?: string[];
  /** Opt-in durable session token budget. Omitted means unbounded. */
  budget?: number;
};

export type CrewCoderResumeOptions = {
  sessionId: string;
  prompt?: string;
  provider: string;
  mode: string;
  worker?: string;
  model?: string;
  systemPrompt?: string;
  effort?: string;
  cwd?: string;
  approval?: CrewCoderApprovalMode;
  images?: string[];
  externalDirectories?: string[];
  /** Opt-in durable session token budget. Omitted means unbounded. */
  budget?: number;
};

export type CrewCoderEventHandler = (event: CrewCoderJsonEvent) => void;

export type SessionRecord = {
  id: string;
  startedAt: string;
  cwd: string;
  requestedMode: string;
  resolvedMode: string;
  prompt: string;
  /** Provider/model/effort the session was last run with, restored on resume. */
  provider?: string;
  model?: string;
  effort?: string;
  externalDirectories?: string[];
};

export type ProviderRecord = {
  id: string;
  title: string;
  kind?: string;
  models: string[];
  defaultModel?: string;
  description?: string;
};

export type ExtensionRendererRecord = {
  extensionId: string;
  id: string;
  title: string;
  target: "tool";
  match: {
    extensionId?: string;
    toolId?: string;
    renderer?: string;
    toolName?: string;
  };
  template: string;
};

export type CrewCoderInvocation = {
  command: string;
  args: string[];
  cwd: string;
};

export class CrewCoderProcessBridge {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stopCurrent: (() => void) | undefined;

  get running(): boolean {
    return Boolean(this.child);
  }

  run(options: CrewCoderProcessOptions, onEvent: CrewCoderEventHandler): () => void {
    this.stop();
    if (options.images?.length && isCrewCoderRemote()) return unsupportedRemoteImages(onEvent);
    const args = [
      "run",
      "--json-events",
      "--provider",
      options.provider,
      "--mode",
      options.mode
    ];
    if (options.model) args.push("--model", options.model);
    if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);
    if (options.worker) args.push("--worker", options.worker);
    if (options.effort) args.push("--effort", options.effort);
    if (options.approval) args.push("--approval", options.approval);
    if (typeof options.budget === "number" && options.budget > 0) args.push("--budget", String(options.budget));
    if (options.parentSessionId) args.push("--parent-session", options.parentSessionId);
    for (const directory of options.externalDirectories ?? []) args.push("--add-dir", directory);
    for (const image of options.images ?? []) args.push("--image", image);
    args.push(options.prompt);
    return this.spawn(args, options.cwd ?? process.cwd(), onEvent);
  }

  resume(options: CrewCoderResumeOptions, onEvent: CrewCoderEventHandler): () => void {
    this.stop();
    if (options.images?.length && isCrewCoderRemote()) return unsupportedRemoteImages(onEvent);
    const args = [
      "session",
      "resume",
      options.sessionId,
      "--json-events",
      "--provider",
      options.provider,
      "--mode",
      options.mode
    ];
    if (options.model) args.push("--model", options.model);
    if (options.systemPrompt) args.push("--system-prompt", options.systemPrompt);
    if (options.worker) args.push("--worker", options.worker);
    if (options.effort) args.push("--effort", options.effort);
    if (options.approval) args.push("--approval", options.approval);
    if (typeof options.budget === "number" && options.budget > 0) args.push("--budget", String(options.budget));
    for (const directory of options.externalDirectories ?? []) args.push("--add-dir", directory);
    for (const image of options.images ?? []) args.push("--image", image);
    if (options.prompt?.trim()) args.push(options.prompt.trim());
    return this.spawn(args, options.cwd ?? process.cwd(), onEvent);
  }

  writeLine(line: string): void {
    if (!this.child) return;
    this.child.stdin.write(line + "\n");
  }

  followUp(message: string): boolean {
    if (!this.child || !message.trim()) return false;
    this.writeLine(JSON.stringify({ type: "control", action: "follow_up", message }));
    return true;
  }

  /**
   * Ask the live agent loop to compact now but pause for a preview instead of
   * installing the summary immediately. The backend responds with a
   * `session_compaction_preview` event carrying the proposed summary.
   */
  requestCompactionPreview(): boolean {
    if (!this.child) return false;
    this.writeLine(JSON.stringify({ type: "control", action: "compact", preview: true }));
    return true;
  }

  /**
   * Answer a `session_compaction_preview`. `approved: false` cancels; a non-empty
   * `summary` installs the user-edited text instead of the proposed one.
   */
  resolveCompactionPreview(previewId: string, approved: boolean, summary?: string): boolean {
    if (!this.child || !previewId.trim()) return false;
    this.writeLine(JSON.stringify({
      type: "control",
      action: "compact_preview",
      previewId: previewId.trim(),
      approved,
      ...(summary && summary.trim() ? { summary } : {})
    }));
    return true;
  }

  resolveApproval(approvalId: string, approved: boolean, reason?: string): boolean {
    if (!this.child || !approvalId.trim()) return false;
    this.writeLine(JSON.stringify({
      type: "control",
      action: "approval",
      approvalId: approvalId.trim(),
      approved,
      ...(reason?.trim() ? { reason: reason.trim() } : {})
    }));
    return true;
  }

  /**
   * Answer an `extension_ui_request` from a trusted extension. `value` is the
   * raw response: boolean for confirm, string for input/select, or null to
   * cancel. Mirrors the approval control channel.
   */
  resolveUiRequest(requestId: string, value: string | boolean | null): boolean {
    if (!this.child || !requestId.trim()) return false;
    this.writeLine(JSON.stringify({
      type: "control",
      action: "ui_response",
      requestId: requestId.trim(),
      value
    }));
    return true;
  }

  stop(): void {
    this.stopCurrent?.();
    this.stopCurrent = undefined;
    this.child = undefined;
  }

  private spawn(args: string[], cwd: string, onEvent: CrewCoderEventHandler): () => void {
    const invocation = resolveCrewCoderInvocation(args, cwd);
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        FORCE_COLOR: "0"
      }
    });

    this.child = child;

    onEvent({
      type: "tui_process_start",
      command: invocation.command,
      args: invocation.args
    });

    let stdoutBuffer = "";

    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      let index = stdoutBuffer.indexOf("\n");
      while (index >= 0) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        const event = safeParseLine(line);
        if (event) onEvent(event);
        index = stdoutBuffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      onEvent({
        type: "stderr",
        text: chunk.toString()
      });
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      const help = error.code === "EACCES"
        ? [
            `Cannot execute "${invocation.command}". The file exists, but it is not executable.`,
            "",
            "Fix:",
            "  cd crewcoder/crewcoder-agent",
            "  npm run build",
            "  chmod +x dist/cli.js",
            "",
            "You can also point the TUI at a custom binary:",
            "  CREWCODER_BIN=/absolute/path/to/crewcoder npm run dev"
          ].join("\n")
        : error.message;

      onEvent({
        type: "process_error",
        message: help,
        code: error.code
      });
    });

    child.on("close", (code) => {
      // A completed run can be replaced as soon as its session is saved. Do
      // not let the old child's delayed close event clear or stop the new run.
      if (this.child !== child) return;
      this.child = undefined;
      this.stopCurrent = undefined;
      onEvent({
        type: "process_exit",
        code
      });
    });

    const stopChild = (): void => {
      if (!child.killed) child.kill("SIGTERM");
    };
    this.stopCurrent = stopChild;

    return this.stopCurrent;
  }
}

export function spawnCrewCoderRun(options: CrewCoderProcessOptions, onEvent: CrewCoderEventHandler): () => void {
  const bridge = new CrewCoderProcessBridge();
  return bridge.run(options, onEvent);
}

export function execCrewCoderCommand(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const invocation = resolveCrewCoderInvocation(args, process.cwd());
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 0 });
    });
  });
}

export function listCrewCoderSessions(): Promise<SessionRecord[]> {
  return new Promise((resolve, reject) => {
    const invocation = resolveCrewCoderInvocation(["session", "list", "--json"], process.cwd());
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `session list exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || "[]") as SessionRecord[]);
      } catch {
        resolve([]);
      }
    });
  });
}

export function branchCrewCoderSession(id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const invocation = resolveCrewCoderInvocation(["session", "branch", id], process.cwd());
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `session branch exited with code ${code}`));
        return;
      }
      resolve(extractBranchedSessionId(stdout) ?? stdout.trim());
    });
  });
}

export function listCrewCoderProviders(): Promise<ProviderRecord[]> {
  return listCrewCoderProvidersFromCli();
}

export async function listCrewCoderExtensionRenderers(): Promise<ExtensionRendererRecord[]> {
  const { stdout, stderr, exitCode } = await execCrewCoderCommand(["extension", "renderers", "--json"]);
  if (exitCode !== 0) throw new Error(stderr || `extension renderers exited with code ${exitCode}`);
  return parseExtensionRendererRecords(JSON.parse(stdout || "[]"));
}

export type LiveUiContributionSummary = {
  extensionId: string;
  extensionName: string;
  id: string;
  title: string;
  surface: string;
  slot?: string;
  entry: string;
  experimental: boolean;
  permissions: Record<string, unknown>;
  match?: Record<string, unknown>;
  activation?: Record<string, unknown>;
  enabled: boolean;
  trusted: boolean;
  allowed: boolean;
  blockedReasons: string[];
};

export async function listCrewCoderLiveUiContributions(): Promise<LiveUiContributionSummary[]> {
  if (isCrewCoderRemote()) return [];
  const { stdout, stderr, exitCode } = await execCrewCoderCommand(["extension", "live-ui", "--json"]);
  if (exitCode !== 0) throw new Error(stderr || `extension live-ui exited with code ${exitCode}`);
  return parseLiveUiContributionRecords(JSON.parse(stdout || "[]"));
}

function listCrewCoderProvidersFromCli(): Promise<ProviderRecord[]> {
  return new Promise((resolve, reject) => {
    const invocation = resolveCrewCoderInvocation(["providers", "--json"], process.cwd());
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" }
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `providers exited with code ${code}`));
        return;
      }
      try {
        resolve(parseProviderRecords(JSON.parse(stdout.trim() || "[]")));
      } catch {
        resolve(parseProviders(stdout));
      }
    });
  });
}

function safeParseLine(line: string): CrewCoderJsonEvent | undefined {
  try {
    return parseCrewCoderEvent(line);
  } catch {
    return {
      type: "stdout",
      text: line
    };
  }
}

function extractBranchedSessionId(stdout: string): string | undefined {
  const match = stdout.match(/Created branch session\s+(\S+)/);
  return match?.[1];
}

function parseProviders(stdout: string): ProviderRecord[] {
  const providers: ProviderRecord[] = [];
  let current: ProviderRecord | undefined;

  for (const line of stdout.split("\n")) {
    const header = line.match(/^(\S+)\s+\(([^)]+)\)\s+-\s+(.+)$/);
    if (header) {
      current = { id: header[1]!, kind: header[2], title: header[3]!, models: [] };
      providers.push(current);
      continue;
    }
    if (!current) continue;
    const models = line.match(/^\s+models:\s+(.+)$/);
    if (models) {
      current.models = models[1]!.split(",").map((model) => model.trim()).filter(Boolean);
      continue;
    }
    const defaultModel = line.match(/^\s+default:\s+(.+)$/);
    if (defaultModel) {
      current.defaultModel = defaultModel[1]!.trim();
      continue;
    }
    const description = line.match(/^\s+([^:]+)$/);
    if (description) current.description = description[1]!.trim();
  }

  return providers;
}

function parseExtensionRendererRecords(value: unknown): ExtensionRendererRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const match = record.match && typeof record.match === "object" && !Array.isArray(record.match) ? record.match as Record<string, unknown> : undefined;
    if (typeof record.extensionId !== "string" || typeof record.id !== "string" || typeof record.title !== "string" || record.target !== "tool" || typeof record.template !== "string" || !match) return [];
    return [{
      extensionId: record.extensionId,
      id: record.id,
      title: record.title,
      target: "tool" as const,
      match: {
        extensionId: typeof match.extensionId === "string" ? match.extensionId : undefined,
        toolId: typeof match.toolId === "string" ? match.toolId : undefined,
        renderer: typeof match.renderer === "string" ? match.renderer : undefined,
        toolName: typeof match.toolName === "string" ? match.toolName : undefined
      },
      template: record.template
    }];
  });
}

function parseLiveUiContributionRecords(value: unknown): LiveUiContributionSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.extensionId !== "string" || typeof record.id !== "string" || typeof record.title !== "string" || typeof record.surface !== "string") return [];
    return [{
      extensionId: record.extensionId,
      extensionName: typeof record.extensionName === "string" ? record.extensionName : record.extensionId,
      id: record.id,
      title: record.title,
      surface: record.surface,
      slot: typeof record.slot === "string" ? record.slot : undefined,
      entry: typeof record.entry === "string" ? record.entry : "",
      experimental: record.experimental === true,
      permissions: record.permissions && typeof record.permissions === "object" && !Array.isArray(record.permissions) ? record.permissions as Record<string, unknown> : {},
      match: record.match && typeof record.match === "object" && !Array.isArray(record.match) ? record.match as Record<string, unknown> : undefined,
      activation: record.activation && typeof record.activation === "object" && !Array.isArray(record.activation) ? record.activation as Record<string, unknown> : undefined,
      enabled: record.enabled === true,
      trusted: record.trusted === true,
      allowed: record.allowed === true,
      blockedReasons: Array.isArray(record.blockedReasons) ? record.blockedReasons.filter((r): r is string => typeof r === "string") : []
    }];
  });
}

function parseProviderRecords(value: unknown): ProviderRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string") return [];
    const models = Array.isArray(record.models)
      ? record.models.map((model) => String(model)).filter(Boolean)
      : [];
    return [{
      id: record.id,
      title: typeof record.title === "string" ? record.title : record.id,
      kind: typeof record.kind === "string" ? record.kind : undefined,
      models,
      defaultModel: typeof record.defaultModel === "string" ? record.defaultModel : undefined,
      description: typeof record.description === "string" ? record.description : undefined
    }];
  });
}

export function isCrewCoderRemote(): boolean {
  return readCrewCoderRemoteConnection() !== undefined;
}

export function resolveCrewCoderInvocation(args: string[], cwd = process.cwd()): CrewCoderInvocation {
  const remote = readCrewCoderRemoteConnection();
  if (remote) {
    return {
      command: "ssh",
      args: ["-T", remote.target, buildRemoteCrewCoderCommand(remote, args)],
      cwd: process.cwd()
    };
  }
  if (process.env.CREWCODER_BIN) return { command: process.env.CREWCODER_BIN, args, cwd };

  const here = path.dirname(fileURLToPath(import.meta.url));
  const local = path.resolve(here, "../../../crewcoder-agent/dist/cli.js");
  if (fs.existsSync(local)) return { command: process.execPath, args: [local, ...args], cwd };

  return { command: "crewcoder", args, cwd };
}

function unsupportedRemoteImages(onEvent: CrewCoderEventHandler): () => void {
  onEvent({
    type: "process_error",
    message: "Image attachments are not available in remote SSH mode yet. Remove the local image and send the prompt again."
  });
  return () => {};
}
