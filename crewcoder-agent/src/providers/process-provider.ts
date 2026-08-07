import { spawn } from "node:child_process";
import type { ProviderRunInput, ProviderRunResult } from "./types.js";

export async function runProcessProvider(input: ProviderRunInput, signal?: AbortSignal): Promise<ProviderRunResult> {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const args = renderArgs(input.provider.args, input);
  const startedAt = Date.now();

  await input.debug?.event({
    level: "info",
    source: "provider.process",
    message: "starting provider process",
    details: {
      providerId: input.provider.id,
      command: input.provider.command,
      args: redactArgs(args),
      cwd: input.cwd,
      model: input.model,
      timeoutMs
    }
  });

  return new Promise((resolve) => {
    const child = spawn(input.provider.command, args, {
      cwd: input.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(input.provider.env ?? {}) }
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void input.debug?.event({ level: "warn", source: "provider.process", message: "provider timed out; sending SIGTERM", details: { providerId: input.provider.id, timeoutMs } });
      child.kill("SIGTERM");
    }, timeoutMs);
    const abort = () => {
      void input.debug?.event({ level: "warn", source: "provider.process", message: "provider aborted; sending SIGTERM", details: { providerId: input.provider.id } });
      child.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      stdout += chunk.toString();
      if (stdout.length > 300_000) stdout = stdout.slice(-300_000);
      void input.debug?.event({ level: "debug", source: "provider.stdout", message: "provider stdout chunk", details: { providerId: input.provider.id, bytes: chunk.length, preview: previewChunk(chunk) } });
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      stderr += chunk.toString();
      if (stderr.length > 300_000) stderr = stderr.slice(-300_000);
      void input.debug?.event({ level: "debug", source: "provider.stderr", message: "provider stderr chunk", details: { providerId: input.provider.id, bytes: chunk.length, preview: previewChunk(chunk) } });
    });
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
      void input.debug?.event({ level: "error", source: "provider.process", message: "provider process error", details: { providerId: input.provider.id, error: error.message } });
    });
    child.on("close", (code) => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      const cleanStdout = stripAnsi(stdout).trim();
      const cleanStderr = stripAnsi(stderr).trim();
      const text = code === 0
        ? (cleanStdout || cleanStderr || "(no output)")
        : [cleanStdout, cleanStderr].filter(Boolean).join("\n").trim() || "(no output)";
      void input.debug?.event({
        level: code === 0 ? "info" : "error",
        source: "provider.process",
        message: "provider process closed",
        details: { providerId: input.provider.id, exitCode: code, timedOut, durationMs: Date.now() - startedAt, stdoutBytes, stderrBytes, outputChars: text.length }
      });
      resolve({ providerId: input.provider.id, text, stdout: cleanStdout, stderr: cleanStderr, exitCode: code, timedOut });
    });
  });
}

function renderArgs(args: string[], input: ProviderRunInput): string[] {
  const rendered: string[] = [];
  const model = input.model?.trim();

  for (const arg of args) {
    const modelArg = arg.match(/^\{\{modelArg:(.+)\}\}$/);
    if (modelArg) {
      if (model && model !== "default") rendered.push(modelArg[1]!, model);
      continue;
    }

    const value = renderArg(arg, input);
    if (value !== "") rendered.push(value);
  }

  return rendered;
}

function renderArg(arg: string, input: ProviderRunInput): string {
  return arg
    .replaceAll("{{prompt}}", input.prompt)
    .replaceAll("{{cwd}}", input.cwd)
    .replaceAll("{{model}}", input.model && input.model !== "default" ? input.model : "");
}

function previewChunk(chunk: Buffer): string {
  const text = chunk.toString().replace(/\s+/g, " ").trim();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function redactArgs(args: string[]): string[] {
  return args.map((arg) => arg.length > 240 ? `${arg.slice(0, 240)}...` : arg);
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}
