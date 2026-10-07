import { spawn } from "node:child_process";
import type { AuthFile } from "./auth-store.js";
import type { ProviderDefinition } from "./types.js";

export const PROVIDER_AUTH_STATUS_SCHEMA_VERSION = 1;
const CLI_STATUS_TIMEOUT_MS = 10_000;

export type ProviderAuthState = "signed-in" | "signed-out" | "not-installed" | "unknown";
export type ProviderAuthSource = "crewcoder-oauth" | "stored-api-key" | "env" | "cli";

export type ProviderAuthStatus = {
  id: string;
  title: string;
  state: ProviderAuthState;
  source?: ProviderAuthSource;
  detail?: string;
};

export type CliStatusResult = { missing: boolean; code: number | null; stdout: string };

export type ProviderAuthProbe = {
  authFile: AuthFile;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  now: number;
  runCli(command: string, args: string[]): Promise<CliStatusResult>;
};

/**
 * Read-only sign-in report. Never refreshes tokens, never writes auth files, and
 * never echoes account identity, because callers forward it to a Relay Host.
 */
export async function collectProviderAuthStatus(providers: ProviderDefinition[], probe: ProviderAuthProbe): Promise<ProviderAuthStatus[]> {
  return Promise.all(providers.map((provider) => providerAuthStatus(provider, probe)));
}

async function providerAuthStatus(provider: ProviderDefinition, probe: ProviderAuthProbe): Promise<ProviderAuthStatus> {
  const base = { id: provider.id, title: provider.title };
  if (provider.kind === "builtin" && provider.id === "codex-cli") return { ...base, ...await codexCliStatus(provider, probe) };
  if (provider.kind === "builtin" && provider.runtime === "claude-agent-sdk") return { ...base, ...await claudeCliStatus(probe) };
  return { ...base, ...storedOrEnvStatus(provider, probe) };
}

async function codexCliStatus(provider: ProviderDefinition, probe: ProviderAuthProbe): Promise<Omit<ProviderAuthStatus, "id" | "title">> {
  const command = probe.env.CREWCODER_CODEX_PATH || provider.command || "codex";
  const result = await probe.runCli(command, ["login", "status"]);
  if (result.missing) return missingCli(probe, "CREWCODER_CODEX_PATH");
  if (result.code === null) return { state: "unknown", source: "cli", detail: "codex login status did not finish" };
  return result.code === 0 ? { state: "signed-in", source: "cli" } : { state: "signed-out", source: "cli", detail: "Run: codex login" };
}

async function claudeCliStatus(probe: ProviderAuthProbe): Promise<Omit<ProviderAuthStatus, "id" | "title">> {
  const result = await probe.runCli(probe.env.CREWCODER_CLAUDE_PATH || "claude", ["auth", "status", "--json"]);
  if (result.missing) {
    // The Agent SDK can still run with an API key even without a claude binary on PATH.
    if (probe.env.ANTHROPIC_API_KEY) return { state: "signed-in", source: "env", detail: "ANTHROPIC_API_KEY" };
    return missingCli(probe, "CREWCODER_CLAUDE_PATH");
  }
  if (result.code === null) return { state: "unknown", source: "cli", detail: "claude auth status did not finish" };
  const parsed = parseJsonRecord(result.stdout);
  if (!parsed || typeof parsed.loggedIn !== "boolean") return { state: "unknown", source: "cli", detail: "Unrecognized claude auth status output" };
  // Only the method is forwarded; the CLI also reports email and organization.
  const method = typeof parsed.authMethod === "string" ? parsed.authMethod : undefined;
  return parsed.loggedIn ? { state: "signed-in", source: "cli", ...(method ? { detail: method } : {}) } : { state: "signed-out", source: "cli", detail: "Run: claude auth login" };
}

function storedOrEnvStatus(provider: ProviderDefinition, probe: ProviderAuthProbe): Omit<ProviderAuthStatus, "id" | "title"> {
  // Mirrors getProviderAuth lookup rules without its refresh side effect.
  const credential = probe.authFile[provider.id] ?? (provider.kind === "builtin" && provider.apiKeyEnv ? probe.authFile[provider.apiKeyEnv] : undefined);
  if (credential?.type === "api_key") {
    return resolveStoredKey(credential.key, probe.env)
      ? { state: "signed-in", source: "stored-api-key" }
      : { state: "signed-out", source: "stored-api-key", detail: "Stored key references an unset environment variable" };
  }
  if (credential?.type === "oauth" && provider.kind === "builtin") {
    const expired = probe.now >= credential.expires;
    return { state: "signed-in", source: "crewcoder-oauth", ...(expired ? { detail: "Access token expired; refreshes on next use" } : {}) };
  }
  if (provider.apiKeyEnv && probe.env[provider.apiKeyEnv]) return { state: "signed-in", source: "env", detail: provider.apiKeyEnv };
  // ACP and process providers own their sign-in inside their own CLI.
  if (provider.runtime === "acp-client" || provider.runtime === "process" || provider.runtime === "model-command") return { state: "unknown" };
  return { state: "signed-out" };
}

function missingCli(probe: ProviderAuthProbe, overrideEnv: string): Omit<ProviderAuthStatus, "id" | "title"> {
  // Windows npm installs are .cmd shims that a shell-free spawn cannot find by bare name.
  if (probe.platform === "win32") return { state: "unknown", source: "cli", detail: `CLI not found on PATH; set ${overrideEnv} to the executable` };
  return { state: "not-installed", source: "cli" };
}

function resolveStoredKey(value: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!value.startsWith("$")) return value;
  const name = value.startsWith("${") && value.endsWith("}") ? value.slice(2, -1) : value.slice(1);
  return env[name];
}

function parseJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export function runCliStatusCommand(command: string, args: string[]): Promise<CliStatusResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (result: CliStatusResult) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => { child.kill("SIGTERM"); finish({ missing: false, code: null, stdout }); }, CLI_STATUS_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString()}`.slice(-64_000); });
    child.once("error", (error: NodeJS.ErrnoException) => finish({ missing: error.code === "ENOENT", code: null, stdout }));
    child.once("close", (code) => finish({ missing: false, code, stdout }));
  });
}
