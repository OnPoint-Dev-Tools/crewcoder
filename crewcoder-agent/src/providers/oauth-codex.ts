export type CodexOAuthCredentials = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
  /** Required by the official Codex app-server durable thread store. */
  idToken?: string;
};

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE_URL = "https://auth.openai.com";
const TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEVICE_USER_CODE_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${AUTH_BASE_URL}/api/accounts/deviceauth/token`;
export const DEVICE_VERIFICATION_URI = `${AUTH_BASE_URL}/codex/device`;
const DEVICE_REDIRECT_URI = `${AUTH_BASE_URL}/deviceauth/callback`;
const DEVICE_CODE_TIMEOUT_SECONDS = 15 * 60;
const JWT_CLAIM_PATH = "https://api.openai.com/auth";

type OAuthToken = { access: string; refresh: string; expires: number; idToken?: string };

type DeviceAuthInfo = {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
};

export async function loginCodexDeviceCode(callbacks: {
  onDeviceCode(info: { userCode: string; verificationUri: string; expiresInSeconds: number }): void;
  onPoll?(message: string): void;
  signal?: AbortSignal;
}): Promise<CodexOAuthCredentials> {
  const device = await startDeviceAuth(callbacks.signal);
  callbacks.onDeviceCode({ userCode: device.userCode, verificationUri: DEVICE_VERIFICATION_URI, expiresInSeconds: DEVICE_CODE_TIMEOUT_SECONDS });
  const code = await pollDeviceAuth(device, callbacks.onPoll, callbacks.signal);
  return credentialsFromToken(await exchangeAuthorizationCode(code.authorizationCode, code.codeVerifier, callbacks.signal));
}

export async function refreshCodexCredentials(credentials: CodexOAuthCredentials): Promise<CodexOAuthCredentials> {
  const refreshed = credentialsFromToken(await refreshAccessToken(credentials.refresh));
  return { ...refreshed, idToken: refreshed.idToken ?? credentials.idToken };
}

function credentialsFromToken(token: OAuthToken): CodexOAuthCredentials {
  return {
    type: "oauth",
    access: token.access,
    refresh: token.refresh,
    expires: token.expires,
    accountId: extractAccountId(token.access),
    idToken: token.idToken
  };
}

function extractAccountId(accessToken: string): string {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) throw new Error("Invalid JWT");
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, any>;
    const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
    if (typeof accountId === "string" && accountId) return accountId;
  } catch {
    // fall through
  }
  throw new Error("Failed to extract ChatGPT account id from Codex OAuth token");
}

async function startDeviceAuth(signal?: AbortSignal): Promise<DeviceAuthInfo> {
  const response = await fetch(DEVICE_USER_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal
  });

  if (!response.ok) throw new Error(`OpenAI Codex device auth failed (${response.status}): ${await response.text()}`);

  const json = await response.json() as { device_auth_id?: string; user_code?: string; interval?: number | string };
  const intervalSeconds = typeof json.interval === "string" ? Number(json.interval) : json.interval;
  if (!json.device_auth_id || !json.user_code || typeof intervalSeconds !== "number") {
    throw new Error(`Invalid OpenAI Codex device auth response: ${JSON.stringify(json)}`);
  }

  return { deviceAuthId: json.device_auth_id, userCode: json.user_code, intervalSeconds };
}

async function pollDeviceAuth(device: DeviceAuthInfo, onPoll?: (message: string) => void, signal?: AbortSignal): Promise<{ authorizationCode: string; codeVerifier: string }> {
  const started = Date.now();
  let intervalMs = Math.max(1, device.intervalSeconds) * 1000;

  while (Date.now() - started < DEVICE_CODE_TIMEOUT_SECONDS * 1000) {
    await sleep(intervalMs, signal);
    onPoll?.("Waiting for OpenAI authorization...");

    const response = await fetch(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
      signal
    });

    if (response.ok) {
      const json = await response.json() as { authorization_code?: string; code_verifier?: string };
      if (!json.authorization_code || !json.code_verifier) throw new Error(`Invalid OpenAI Codex device token response: ${JSON.stringify(json)}`);
      return { authorizationCode: json.authorization_code, codeVerifier: json.code_verifier };
    }

    const text = await response.text().catch(() => "");
    if (response.status === 403 || response.status === 404 || /authorization_pending/i.test(text)) continue;
    if (/slow_down/i.test(text)) { intervalMs += 5000; continue; }
    throw new Error(`OpenAI Codex device auth polling failed (${response.status}): ${text}`);
  }

  throw new Error("OpenAI Codex device auth timed out");
}

async function exchangeAuthorizationCode(code: string, verifier: string, signal?: AbortSignal): Promise<OAuthToken> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: DEVICE_REDIRECT_URI
    }),
    signal
  });
  return readTokenResponse(response, "exchange");
}

async function refreshAccessToken(refreshToken: string): Promise<OAuthToken> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: CLIENT_ID })
  });
  return readTokenResponse(response, "refresh");
}

async function readTokenResponse(response: Response, op: string): Promise<OAuthToken> {
  if (!response.ok) throw new Error(`OpenAI Codex token ${op} failed (${response.status}): ${await response.text()}`);
  const json = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string };
  if (!json.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
    throw new Error(`OpenAI Codex token ${op} response missing fields: ${JSON.stringify(json)}`);
  }
  return { access: json.access_token, refresh: json.refresh_token, expires: Date.now() + json.expires_in * 1000, idToken: json.id_token };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Login cancelled")); return; }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timeout); reject(new Error("Login cancelled")); }, { once: true });
  });
}
