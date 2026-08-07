// Extension trust tiers (Feature 3).
//
// Replaces the previous binary trusted/untrusted model with three tiers:
//   - trusted     full tool access, module execution, hooks, renderers, live UI.
//   - sandboxed   read + write to the workspace only; command tools run inside the
//                 sandbox (see core/sandbox.ts) with network disabled by default.
//   - prompt-only can contribute skills/promptPacks/commands (prompt fragments) but
//                 gets no tools, hooks, modules, or UI code. This is the default.
//
// Storage stays backward compatible: `config.trustedExtensions` is the "trusted"
// tier list, `config.sandboxedExtensions` is the "sandboxed" tier list, and any
// enabled extension in neither list is "prompt-only".

import type { CrewCoderConfig } from "./config.js";

export type TrustTier = "trusted" | "sandboxed" | "prompt-only";

export const TRUST_TIERS: readonly TrustTier[] = ["trusted", "sandboxed", "prompt-only"];

export function isTrustTier(value: string): value is TrustTier {
  return (TRUST_TIERS as readonly string[]).includes(value);
}

/** Resolve the effective trust tier for an extension id. */
export function getTrustTier(config: CrewCoderConfig, extensionId: string): TrustTier {
  if (config.trustedExtensions.includes(extensionId)) return "trusted";
  if (config.sandboxedExtensions.includes(extensionId)) return "sandboxed";
  return "prompt-only";
}

/** True only for the full-access tier (the old `trusted` semantics). */
export function isExtensionTrusted(config: CrewCoderConfig, extensionId: string): boolean {
  return getTrustTier(config, extensionId) === "trusted";
}

export type ExtensionCapabilities = {
  tier: TrustTier;
  /** May contribute executable command tools at all. */
  tools: boolean;
  /** Command tools must run inside the sandbox rather than with full host access. */
  toolsSandboxed: boolean;
  /** May run in-process module code, hooks, renderers, approval policies, live UI. */
  fullAccess: boolean;
};

export function getExtensionCapabilities(config: CrewCoderConfig, extensionId: string): ExtensionCapabilities {
  const tier = getTrustTier(config, extensionId);
  if (tier === "trusted") return { tier, tools: true, toolsSandboxed: false, fullAccess: true };
  if (tier === "sandboxed") return { tier, tools: true, toolsSandboxed: true, fullAccess: false };
  return { tier, tools: false, toolsSandboxed: false, fullAccess: false };
}
