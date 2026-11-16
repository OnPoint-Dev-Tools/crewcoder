import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensureCrewCoderHome } from "../core/crewcoder-home.js";
import { redactSecrets } from "../core/secret-redaction.js";

const CATALOG_LIMIT = 8 * 1024 * 1024;

export async function codexHostedModelCatalog(
  command: string, cwd: string, lockdown: string[], model?: string, signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted();
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...lockdown, "debug", "models"], {
      cwd, shell: false, stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) { child.kill(); reject(error); }
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const abort = () => finish(new Error("Codex tool catalog discovery cancelled"));
    const timer = setTimeout(() => finish(new Error("Codex tool catalog discovery timed out")), 20_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > CATALOG_LIMIT) finish(new Error("Codex model catalog exceeds 8 MiB"));
      else chunks.push(chunk);
    });
    // Preserve bounded diagnostic evidence so config errors aren't mislabeled
    // as a missing CLI or login; redact before reporting it to the host.
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8192); });
    child.once("error", error => finish(error));
    child.once("close", (code, exitSignal) => {
      const detail = redactSecrets(stderr).replace(/((?:token|password|secret|api[_-]?key)\s*[=:]\s*)("[^"]*"|[^\s,&)]+)/gi, "$1[REDACTED]").trim().slice(-4096);
      finish(code === 0 ? undefined : new Error(`Codex debug models exited with ${exitSignal ? `signal ${exitSignal}` : `code ${code}`}${detail ? `: ${detail}` : ""}`));
    });
  });
  const parsed: unknown = JSON.parse(output);
  if (!parsed || typeof parsed !== "object" || !("models" in parsed) || !Array.isArray(parsed.models)
    || parsed.models.length === 0 || parsed.models.length > 1000) throw new Error("Invalid Codex model catalog");
  const models = parsed.models.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || !("slug" in entry) || typeof entry.slug !== "string" || !entry.slug) {
      throw new Error("Invalid Codex model catalog entry");
    }
    // Native apply_patch is model-gated, not feature-gated. Omit it from the
    // actual tool registry instead of offering a tool the sandbox must reject.
    return { ...entry, apply_patch_tool_type: null };
  });
  if (model && !models.some(entry => entry.slug === model)) throw new Error(`Codex model catalog does not contain selected model ${model}`);
  signal?.throwIfAborted();
  const contents = JSON.stringify({ models });
  const digest = createHash("sha256").update(contents).digest("hex");
  const directory = path.join(ensureCrewCoderHome().cacheDir, "codex-hosted-model-catalog");
  await fs.mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${digest}.json`);
  const temporary = path.join(directory, `${digest}-${randomUUID()}.tmp`);
  await fs.writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  await fs.rename(temporary, destination);
  signal?.throwIfAborted();
  return destination;
}
