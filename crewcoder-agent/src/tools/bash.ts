import { spawn } from "node:child_process";
import type { ToolDefinition, ToolContext } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { wrapShellCommand, prepareSandboxNetwork, SANDBOX_UNAVAILABLE_MESSAGE } from "../core/sandbox.js";
import { assertStrictIsolationAvailable, runStrictIsolated } from "../core/sandbox-strict.js";
import { DEFAULT_TOOL_OUTPUT_BYTES, DEFAULT_TOOL_OUTPUT_LINES, truncateToolOutputTail } from "./tool-output-limits.js";

type Args = { command: string; timeoutMs: number };

const blocked = ["rm -rf /", "mkfs", "shutdown", "reboot", ":(){:|:&};:", "dd if="];
const MAX_CAPTURE_CHARS = 120_000;

export const bashTool: ToolDefinition<Args> = {
  name: "bash",
  description: "Run a shell command in the workspace with timeout and basic destructive-command guardrails. Model-visible output keeps the last 2,000 lines or 50KB and reports truncation.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run from the workspace root." },
      timeoutMs: { type: "integer", description: "Timeout in milliseconds.", minimum: 1000, maximum: 120000 }
    },
    required: ["command"],
    additionalProperties: false
  },
  executionMode: "sequential",
  parse(args) {
    return {
      command: String(args.command ?? ""),
      timeoutMs: typeof args.timeoutMs === "number" ? Math.min(Math.max(args.timeoutMs, 1000), 120000) : 30000
    };
  },
  async execute(args, context, signal) {
    if (!args.command) throw new Error("command is required");
    if (signal?.aborted) throw new Error("Operation aborted");
    if (blocked.some((token) => args.command.includes(token))) throw new Error(`Blocked risky command: ${args.command}`);

    // Strict tier: kernel-enforced network isolation (unshare+slirp4netns+nft).
    // Fail closed if the host cannot hard-isolate.
    const sandbox = context.sandbox;
    if (sandbox?.policy.enabled && sandbox.policy.networkIsolation === "strict") {
      assertStrictIsolationAvailable();
      const strict = await runStrictIsolated({
        command: args.command,
        cwd: context.cwd,
        workspaceDir: sandbox.policy.workspaceDir,
        writableDirectories: sandbox.policy.writableDirectories,
        allowedHosts: sandbox.policy.network.allowedHosts,
        timeoutMs: args.timeoutMs,
        signal
      });
      const allowed = sandbox.policy.network.allowedHosts;
      const bounded = boundedCommandOutput(strict.output);
      return textResult(bounded.text, {
        exitCode: strict.exitCode,
        timedOut: strict.timedOut,
        truncated: bounded.truncated,
        visibleOutputBytes: bounded.totalBytes,
        sandboxed: true,
        sandboxBackend: "strict",
        allowedHosts: allowed.length ? allowed : undefined,
        deniedHosts: strict.deniedHosts.length ? strict.deniedHosts : undefined
      });
    }

    const spec = buildSpawnSpec(args.command, context);
    const network = context.sandbox?.policy.enabled
      ? await prepareSandboxNetwork(context.sandbox.policy, context.sandbox.backend)
      : { env: {}, dispose: async () => {} };
    try {
      const result = await runCommand(spec, context.cwd, args.timeoutMs, network.env, signal);
      const allowedHosts = context.sandbox?.policy.network.allowedHosts ?? [];
      const bounded = boundedCommandOutput(result.output, result.captureTruncated);
      return textResult(bounded.text, {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: bounded.truncated,
        visibleOutputBytes: bounded.totalBytes,
        sandboxed: spec.sandboxed,
        sandboxBackend: spec.backend,
        allowedHosts: allowedHosts.length ? allowedHosts : undefined
      });
    } finally {
      await network.dispose();
    }
  }
};

type SpawnSpec = { file: string; args: string[]; shell: boolean; sandboxed: boolean; backend: string };

function buildSpawnSpec(command: string, context: ToolContext): SpawnSpec {
  const sandbox = context.sandbox;
  if (!sandbox?.policy.enabled) {
    return { file: command, args: [], shell: true, sandboxed: false, backend: "none" };
  }
  const wrapped = wrapShellCommand(command, sandbox.policy, sandbox.backend);
  // Fail closed: sandbox was requested but no backend is available.
  if (!wrapped.sandboxed) throw new Error(SANDBOX_UNAVAILABLE_MESSAGE);
  return { file: wrapped.file, args: wrapped.args, shell: false, sandboxed: true, backend: wrapped.backend };
}

function runCommand(spec: SpawnSpec, cwd: string, timeoutMs: number, extraEnv: Record<string, string>, signal?: AbortSignal): Promise<{ output: string; exitCode: number | null; timedOut: boolean; captureTruncated: boolean }> {
  return new Promise((resolve) => {
    const env = Object.keys(extraEnv).length ? { ...process.env, ...extraEnv } : process.env;
    const detached = process.platform !== "win32";
    const child = spec.shell
      ? spawn(spec.file, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env, detached })
      : spawn(spec.file, spec.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env, detached });
    let output = "";
    let captureTruncated = false;
    let settled = false;
    let timedOut = false;
    const terminate = (signalName: NodeJS.Signals) => {
      if (!child.pid) return;
      if (process.platform !== "win32") {
        try { process.kill(-child.pid, signalName); return; } catch {}
      }
      child.kill(signalName);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
    }, timeoutMs);
    const abort = () => terminate("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    const append = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > MAX_CAPTURE_CHARS) {
        captureTruncated = true;
        output = output.slice(-MAX_CAPTURE_CHARS);
      }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (error) => {
      output += `\n${error.message}`;
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ output: output.trim() || "(no output)", exitCode: code, timedOut, captureTruncated });
    });
  });
}

function boundedCommandOutput(output: string, captureTruncated = false): { text: string; truncated: boolean; totalBytes: number } {
  const truncation = truncateToolOutputTail(output);
  const truncated = captureTruncated || truncation.truncated;
  if (!truncated) return { text: truncation.text, truncated: false, totalBytes: truncation.totalBytes };
  const notice = `[Command output truncated: showing the last ${DEFAULT_TOOL_OUTPUT_LINES.toLocaleString("en-US")} lines or ${Math.round(DEFAULT_TOOL_OUTPUT_BYTES / 1024)}KB.]`;
  return { text: `${truncation.text}\n\n${notice}`, truncated: true, totalBytes: truncation.totalBytes };
}
