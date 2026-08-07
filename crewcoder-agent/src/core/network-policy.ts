// Host allowlist matching for extension network egress (Feature 2).
// Pure, dependency-free helpers so they are trivially unit-testable and reusable
// by any egress point CrewCoder actually controls (extension subprocess sandbox,
// future provider HTTP boundary).

/** Extract a lowercase hostname from a URL or bare host string. */
export function hostFromUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    return url.hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Match a host against a single allowlist pattern.
 * Supports exact hosts (`api.example.com`), leading wildcards (`*.example.com`),
 * and a bare `*` that allows any host. Matching is case-insensitive.
 * A `*.example.com` pattern also matches the apex `example.com`.
 */
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = host.trim().toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!h || !p) return false;
  if (p === "*") return true;
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h === suffix.slice(1) || h.endsWith(suffix);
  }
  return h === p;
}

/** True when the host is permitted by at least one allowlist entry. */
export function isHostAllowed(host: string, allowedHosts: readonly string[]): boolean {
  if (allowedHosts.length === 0) return false;
  return allowedHosts.some((pattern) => hostMatchesPattern(host, pattern));
}

/** Normalize/validate a raw allowlist into trimmed, de-duplicated, non-empty entries. */
export function normalizeAllowedHosts(input: readonly unknown[] | undefined): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") continue;
    const value = item.trim().toLowerCase();
    if (value) seen.add(value);
  }
  return [...seen].sort();
}
