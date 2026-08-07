const REDACTED = "[REDACTED]";

const SENSITIVE_KEY_PATTERN = /(^|[_-])(api[_-]?key|access[_-]?key|secret|token|password|passwd|credential|authorization|private[_-]?key)([_-]|$)/i;
const ENV_SECRET_LINE_PATTERN = /^(\s*(?:export\s+)?[A-Z_][A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Z0-9_]*\s*=\s*)(.*)$/gim;
const AWS_ACCESS_KEY_PATTERN = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const AWS_SECRET_ACCESS_KEY_PATTERN = /\b[A-Za-z0-9/+]{40}\b/g;
const BEARER_TOKEN_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/gi;
const PRIVATE_KEY_BLOCK_PATTERN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

export function redactSecrets<T>(value: T): T {
  return redactValue(value, undefined) as T;
}

function redactValue(value: unknown, key: string | undefined): unknown {
  if (typeof key === "string" && isSensitiveKey(key)) return REDACTED;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, undefined));
  if (!isPlainObject(value)) return value;

  const entries = Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactObjectValue(entryKey, entryValue, value)] as const);
  return Object.fromEntries(entries);
}

function redactObjectValue(key: string, value: unknown, parent: Record<string, unknown>): unknown {
  if (isSensitiveKey(key)) return REDACTED;
  if (key === "content" && typeof value === "string" && isEnvPath(parent.path)) return REDACTED;
  if ((key === "text" || key === "content") && typeof value === "string") return redactString(value);
  return redactValue(value, key);
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

function isEnvPath(value: unknown): boolean {
  return typeof value === "string" && /(^|[/\\])\.env(?:\.|$)/i.test(value);
}

function redactString(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK_PATTERN, REDACTED)
    .replace(ENV_SECRET_LINE_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(BEARER_TOKEN_PATTERN, (_match, prefix: string) => `${prefix}${REDACTED}`)
    .replace(AWS_ACCESS_KEY_PATTERN, REDACTED)
    .replace(AWS_SECRET_ACCESS_KEY_PATTERN, (match) => looksLikeAwsSecret(match) ? REDACTED : match);
}

function looksLikeAwsSecret(value: string): boolean {
  return /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value) && /[+/]/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
