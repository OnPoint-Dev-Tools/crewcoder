/**
 * Live UI contribution inspection + trust-gate evaluation (SLICE 1).
 *
 * Mirrors `extension-renderers.ts`: it reads `contributes.liveUi[]` from
 * installed extensions and reports whether each contribution would be allowed to
 * run, given the deny-by-default gates documented in `docs/LIVE_UI_COMPONENTS.md`.
 *
 * This module never loads or executes an extension's live UI `entry` module. It
 * is the manifest-side half of the wiring: `crewcoder extension live-ui` renders
 * it, and the TUI mirrors the same gate before spawning a sandboxed worker.
 */

import { readConfig } from "../core/config.js";
import { loadCrewCoderExtensions } from "./extension-loader.js";
import type {
  CrewCoderExtensionLiveUiContribution,
  CrewCoderLiveUiComponentKind,
  CrewCoderLiveUiKind,
  CrewCoderLiveUiMode,
  CrewCoderLiveUiPermissions,
  CrewCoderLiveUiSurface,
  LoadedCrewCoderExtension
} from "./types.js";

/** Surfaces a host is able to render a live component into. */
export const SUPPORTED_LIVE_UI_SURFACES: readonly CrewCoderLiveUiSurface[] = ["modal", "transcript", "status"];

/** Runtime payload sent by the TUI when deciding whether to load a live UI component. */
export type LiveUiMatchPayload = {
  eventType?: string;
  toolName?: string;
  extensionId?: string;
  toolId?: string;
  renderer?: string;
  uiKind?: CrewCoderLiveUiKind;
  componentKind?: CrewCoderLiveUiComponentKind;
  mode?: CrewCoderLiveUiMode;
  commandName?: string;
};

export type LiveUiGateContext = {
  /** The extension is installed and not disabled. */
  enabled: boolean;
  /** The extension id is in `trustedExtensions`. */
  trusted: boolean;
  /** The host `allowExtensionLiveUi` setting is enabled. */
  allowLiveUi: boolean;
  /** Surfaces the host can render into. */
  supportedSurfaces?: readonly CrewCoderLiveUiSurface[];
  /**
   * Optional runtime payload for gate 7 (activation/match rule checking).
   * When omitted, only static manifest checks are performed.
   */
  payload?: LiveUiMatchPayload;
};

export type LiveUiContributionSummary = {
  extensionId: string;
  extensionName: string;
  id: string;
  title: string;
  surface: CrewCoderLiveUiSurface;
  slot?: string;
  entry: string;
  experimental: boolean;
  permissions: CrewCoderLiveUiPermissions;
  enabled: boolean;
  trusted: boolean;
  allowed: boolean;
  /** Deny-by-default reasons; empty when `allowed` is true. */
  blockedReasons: string[];
};

function permissionReasons(permissions: CrewCoderLiveUiPermissions): string[] {
  const reasons: string[] = [];
  const ui = permissions.ui ?? [];
  if (!ui.includes("render")) reasons.push("permissions.ui must include \"render\"");
  const allowedUi = new Set(["render", "input", "focus"]);
  for (const capability of ui) {
    if (!allowedUi.has(capability)) reasons.push(`unsupported ui permission: ${capability}`);
  }
  if (permissions.clipboard && permissions.clipboard !== "none" && permissions.clipboard !== "write" && permissions.clipboard !== "read") {
    reasons.push("permissions.clipboard must be none, write, or read");
  }
  if (permissions.network && !Array.isArray(permissions.network.allowedHosts)) {
    reasons.push("permissions.network.allowedHosts must be an array");
  }
  if (permissions.events && (!Array.isArray(permissions.events) || permissions.events.some((entry) => !entry.startsWith("read:") || entry.length <= "read:".length))) {
    reasons.push("permissions.events entries must start with read:");
  }
  return reasons;
}

/**
 * Check gate 7: activation/match rules against a runtime payload.
 * Returns reasons for each rule that fails to match.
 */
export function checkLiveUiMatchRules(
  contribution: CrewCoderExtensionLiveUiContribution,
  payload: LiveUiMatchPayload
): string[] {
  const reasons: string[] = [];
  const activation = contribution.activation;
  if (activation) {
    if (activation.events && activation.events.length > 0) {
      if (!payload.eventType || !activation.events.includes(payload.eventType)) {
        reasons.push(`activation.event not matched (payload: ${payload.eventType ?? "none"}, expected: ${activation.events.join(", ")})`);
      }
    }
    if (activation.modes && activation.modes.length > 0) {
      if (!payload.mode || !activation.modes.includes(payload.mode)) {
        reasons.push(`activation.mode not matched (payload: ${payload.mode ?? "none"}, expected: ${activation.modes.join(", ")})`);
      }
    }
    if (activation.commands && activation.commands.length > 0) {
      if (!payload.commandName || !activation.commands.includes(payload.commandName)) {
        reasons.push(`activation.command not matched (payload: ${payload.commandName ?? "none"}, expected: ${activation.commands.join(", ")})`);
      }
    }
  }
  const match = contribution.match;
  if (!match) {
    reasons.push("contribution is missing match rules");
    return reasons;
  }
  if (match.eventTypes && match.eventTypes.length > 0) {
    if (!payload.eventType || !match.eventTypes.includes(payload.eventType)) {
      reasons.push(`match.eventTypes not matched (payload: ${payload.eventType ?? "none"}, expected: ${match.eventTypes.join(", ")})`);
    }
  }
  if (match.toolNames && match.toolNames.length > 0) {
    if (!payload.toolName || !match.toolNames.includes(payload.toolName)) {
      reasons.push(`match.toolNames not matched (payload: ${payload.toolName ?? "none"}, expected: ${match.toolNames.join(", ")})`);
    }
  }
  if (match.extensionIds && match.extensionIds.length > 0) {
    if (!payload.extensionId || !match.extensionIds.includes(payload.extensionId)) {
      reasons.push(`match.extensionIds not matched (payload: ${payload.extensionId ?? "none"}, expected: ${match.extensionIds.join(", ")})`);
    }
  }
  if (match.toolIds && match.toolIds.length > 0) {
    if (!payload.toolId || !match.toolIds.includes(payload.toolId)) {
      reasons.push(`match.toolIds not matched (payload: ${payload.toolId ?? "none"}, expected: ${match.toolIds.join(", ")})`);
    }
  }
  if (match.renderers && match.renderers.length > 0) {
    if (!payload.renderer || !match.renderers.includes(payload.renderer)) {
      reasons.push(`match.renderers not matched (payload: ${payload.renderer ?? "none"}, expected: ${match.renderers.join(", ")})`);
    }
  }
  if (match.uiKinds && match.uiKinds.length > 0) {
    if (!payload.uiKind || !match.uiKinds.includes(payload.uiKind)) {
      reasons.push(`match.uiKinds not matched (payload: ${payload.uiKind ?? "none"}, expected: ${match.uiKinds.join(", ")})`);
    }
  }
  if (match.componentKinds && match.componentKinds.length > 0) {
    if (!payload.componentKind || !match.componentKinds.includes(payload.componentKind)) {
      reasons.push(`match.componentKinds not matched (payload: ${payload.componentKind ?? "none"}, expected: ${match.componentKinds.join(", ")})`);
    }
  }
  return reasons;
}

/**
 * Deny-by-default gate. Checks ALL 7 gates:
 *   1. Extension is enabled
 *   2. Extension id is in trustedExtensions
 *   3. allowExtensionLiveUi=true is enabled
 *   4. Contribution has experimental: true
 *   5. Target surface is supported by the host
 *   6. Requested permissions are supported and approved by policy
 *   7. Activation/match rules pass for the current payload (when provided)
 *
 * The reasons list explains each failing gate so `extension live-ui` and the TUI
 * can surface why a live component will not run.
 */
export function evaluateLiveUiGate(
  contribution: CrewCoderExtensionLiveUiContribution,
  context: LiveUiGateContext
): { allowed: boolean; blockedReasons: string[] } {
  const supportedSurfaces = context.supportedSurfaces ?? SUPPORTED_LIVE_UI_SURFACES;
  const reasons: string[] = [];
  if (!context.enabled) reasons.push("extension is disabled");
  if (!context.trusted) reasons.push("extension is not trusted (crewcoder extension trust <id>)");
  if (!context.allowLiveUi) reasons.push("allowExtensionLiveUi is off (crewcoder config set allowExtensionLiveUi true)");
  if (contribution.experimental !== true) reasons.push("contribution is missing experimental: true");
  if (!supportedSurfaces.includes(contribution.target?.surface)) {
    reasons.push(`unsupported surface: ${String(contribution.target?.surface)}`);
  }
  if (!contribution.entry || typeof contribution.entry !== "string") reasons.push("contribution is missing an entry module");
  if (!contribution.match) reasons.push("contribution is missing match rules");
  reasons.push(...permissionReasons(contribution.permissions ?? {}));
  if (context.payload) {
    reasons.push(...checkLiveUiMatchRules(contribution, context.payload));
  }
  return { allowed: reasons.length === 0, blockedReasons: reasons };
}

export function liveUiContributionsFromManifest(
  extension: LoadedCrewCoderExtension,
  context: LiveUiGateContext
): LiveUiContributionSummary[] {
  return (extension.manifest.contributes?.liveUi ?? []).map((contribution) => {
    const gate = evaluateLiveUiGate(contribution, context);
    return {
      extensionId: extension.manifest.id,
      extensionName: extension.manifest.name,
      id: contribution.id,
      title: contribution.title,
      surface: contribution.target?.surface,
      ...(contribution.target?.slot === undefined ? {} : { slot: contribution.target.slot }),
      entry: contribution.entry,
      experimental: contribution.experimental === true,
      permissions: contribution.permissions ?? {},
      enabled: context.enabled,
      trusted: context.trusted,
      allowed: gate.allowed,
      blockedReasons: gate.blockedReasons
    };
  });
}

/**
 * List every live UI contribution across installed extensions with its gate
 * status. Disabled and untrusted extensions are included (and reported as
 * blocked) so operators can see why a live component is not running.
 */
export async function listLiveUiContributions(): Promise<LiveUiContributionSummary[]> {
  const config = readConfig();
  const disabled = new Set(config.disabledExtensions);
  const trusted = new Set(config.trustedExtensions);
  const extensions = await loadCrewCoderExtensions();
  return extensions.flatMap((extension) =>
    liveUiContributionsFromManifest(extension, {
      enabled: !disabled.has(extension.manifest.id),
      trusted: trusted.has(extension.manifest.id),
      allowLiveUi: config.allowExtensionLiveUi
    })
  );
}
