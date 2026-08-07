import fs from "node:fs";
import path from "node:path";
import { ensureCrewCoderHome } from "../core/crewcoder-home.js";
import { refreshCodexCredentials, type CodexOAuthCredentials } from "./oauth-codex.js";
import type { ProviderDefinition } from "./types.js";

export type ApiKeyCredential = { type: "api_key"; key: string };
export type AuthCredential = ApiKeyCredential | CodexOAuthCredentials;
export type AuthFile = Record<string, AuthCredential>;

export type ProviderAuth = {
  token: string;
  credential?: AuthCredential;
};

export async function getProviderAuth(provider: ProviderDefinition): Promise<ProviderAuth | undefined> {
  const auth = readAuthFile();
  // Extension providers may use only credentials stored under their own provider id.
  // Otherwise apiKeyEnv could be set to "codex" to exfiltrate CrewCoder-owned OAuth.
  const cred = auth[provider.id] ?? (provider.kind === "builtin" && provider.apiKeyEnv ? auth[provider.apiKeyEnv] : undefined);

  if (cred?.type === "api_key") {
    const token = resolveKeyValue(cred.key);
    return token ? { token, credential: cred } : undefined;
  }

  if (cred?.type === "oauth") {
    if (provider.kind === "extension") return undefined;
    if (provider.id === "codex") {
      const fresh = Date.now() < cred.expires - 60_000 ? cred : await refreshAndSaveCodex(cred);
      return { token: fresh.access, credential: fresh };
    }
    return { token: cred.access, credential: cred };
  }

  if (provider.apiKeyEnv) {
    const fromEnv = process.env[provider.apiKeyEnv];
    if (fromEnv) return { token: fromEnv };
  }

  return undefined;
}

export async function getProviderApiKey(provider: ProviderDefinition): Promise<string | undefined> {
  return (await getProviderAuth(provider))?.token;
}

export function setAuthCredential(providerId: string, credential: AuthCredential): void {
  const auth = readAuthFile();
  auth[providerId] = credential;
  writeAuthFile(auth);
}

export function removeAuthCredential(providerId: string): void {
  const auth = readAuthFile();
  delete auth[providerId];
  writeAuthFile(auth);
}

export function readAuthFile(): AuthFile {
  const authPath = getAuthPath();
  if (!fs.existsSync(authPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8")) as AuthFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeAuthFile(auth: AuthFile): void {
  const authPath = getAuthPath();
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(authPath, 0o600); } catch {}
}

export function getAuthPath(): string {
  return path.join(ensureCrewCoderHome().root, "auth.json");
}

async function refreshAndSaveCodex(credential: CodexOAuthCredentials): Promise<CodexOAuthCredentials> {
  const refreshed = await refreshCodexCredentials(credential);
  setAuthCredential("codex", refreshed);
  return refreshed;
}

function resolveKeyValue(value: string): string | undefined {
  if (value.startsWith("$")) {
    const envName = value.startsWith("${") && value.endsWith("}") ? value.slice(2, -1) : value.slice(1);
    return process.env[envName];
  }
  return value;
}
