/**
 * Live UI trust-gate evaluation and manifest -> spawn wiring (SLICE 1).
 *
 * This is the TUI-side mirror of `crewcoder-agent/src/extensions/extension-live-ui.ts`.
 * It answers two questions the wiring layer needs before it may spawn a
 * sandboxed worker:
 *
 *   1. Is this live UI contribution allowed to run at all? (deny-by-default gates)
 *   2. If so, what immutable `props` and already-granted `host` should the
 *      `LiveUiHost` be constructed with?
 *
 * Permissions are granted, never trusted verbatim: the requested manifest
 * permissions are intersected with what the host actually supports, so a
 * contribution can only ever receive a subset of what it asked for.
 */

import type {
  CrewCoderLiveUiHost,
  CrewCoderLiveUiKind,
  CrewCoderLiveUiLimits,
  CrewCoderLiveUiPermission,
  CrewCoderLiveUiPermissions,
  CrewCoderLiveUiProps,
  CrewCoderLiveUiSurface
} from "./live-ui-protocol.js";

export const SUPPORTED_LIVE_UI_SURFACES: readonly CrewCoderLiveUiSurface[] = ["modal", "transcript", "status"];

export const DEFAULT_LIVE_UI_LIMITS: CrewCoderLiveUiLimits = {
  maxRenderLines: 200,
  maxLineLength: 512,
  maxPayloadBytes: 64 * 1024
};

export type TuiLiveUiMatch = {
  eventTypes?: string[];
  extensionIds?: string[];
  uiKinds?: string[];
  componentKinds?: string[];
  toolNames?: string[];
  toolIds?: string[];
};

export type TuiLiveUiActivation = {
  events?: string[];
};

export type TuiLiveUiContribution = {
  id: string;
  title: string;
  entry: string;
  experimental?: boolean;
  target: { surface: CrewCoderLiveUiSurface; slot?: string };
  permissions: CrewCoderLiveUiPermissions;
  match?: TuiLiveUiMatch;
  activation?: TuiLiveUiActivation;
};

export type TuiLiveUiGateContext = {
  /** The extension is installed and not disabled. */
  enabled: boolean;
  /** The extension id is in `trustedExtensions`. */
  trusted: boolean;
  /** The host `allowExtensionLiveUi` setting is enabled. */
  allowLiveUi: boolean;
  supportedSurfaces?: readonly CrewCoderLiveUiSurface[];
};

export type TuiLiveUiEvent = {
  type: string;
  requestId?: string;
  extensionId?: string;
  uiKind?: CrewCoderLiveUiKind;
  toolName?: string;
  toolCallId?: string;
  title?: string;
  message?: string;
  component?: CrewCoderLiveUiProps["event"]["component"];
  metadata?: CrewCoderLiveUiProps["event"]["metadata"];
};

export function evaluateTuiLiveUiGate(
  contribution: TuiLiveUiContribution,
  context: TuiLiveUiGateContext
): { allowed: boolean; blockedReasons: string[] } {
  const supportedSurfaces = context.supportedSurfaces ?? SUPPORTED_LIVE_UI_SURFACES;
  const reasons: string[] = [];
  if (!context.enabled) reasons.push("extension is disabled");
  if (!context.trusted) reasons.push("extension is not trusted");
  if (!context.allowLiveUi) reasons.push("allowExtensionLiveUi is off");
  if (contribution.experimental !== true) reasons.push("contribution is missing experimental: true");
  if (!supportedSurfaces.includes(contribution.target?.surface)) {
    reasons.push(`unsupported surface: ${String(contribution.target?.surface)}`);
  }
  if (!contribution.entry) reasons.push("contribution is missing an entry module");
  if (!(contribution.permissions?.ui ?? []).includes("render")) reasons.push("permissions.ui must include \"render\"");
  return { allowed: reasons.length === 0, blockedReasons: reasons };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length ? items : undefined;
}

/**
 * Evaluate a contribution's optional activation.events and match.* rules against
 * an incoming event payload. Missing rules are treated as "match anything" so
 * legacy contributions that declare no rules still spawn on any
 * extension_ui_request.
 */
export function matchesTuiLiveUiContribution(contribution: TuiLiveUiContribution, event: TuiLiveUiEvent): boolean {
  const activation = contribution.activation;
  if (activation) {
    const events = stringArray(activation.events);
    if (events && events.length > 0 && !events.includes(event.type)) return false;
  }
  const match = contribution.match;
  if (!match) return true;
  if (match.eventTypes) {
    const eventTypes = stringArray(match.eventTypes);
    if (eventTypes && eventTypes.length > 0 && !eventTypes.includes(event.type)) return false;
  }
  if (match.extensionIds) {
    const extensionIds = stringArray(match.extensionIds);
    if (extensionIds && extensionIds.length > 0 && !extensionIds.includes(event.extensionId ?? "")) return false;
  }
  if (match.uiKinds) {
    const uiKinds = stringArray(match.uiKinds);
    if (uiKinds && uiKinds.length > 0 && !uiKinds.includes(event.uiKind ?? "")) return false;
  }
  if (match.componentKinds) {
    const componentKinds = stringArray(match.componentKinds);
    if (componentKinds && componentKinds.length > 0) {
      const componentKind = event.component && typeof event.component === "object" && !Array.isArray(event.component)
        ? (event.component as Record<string, unknown>).kind
        : undefined;
      if (!componentKinds.includes(String(componentKind))) return false;
    }
  }
  if (match.toolNames) {
    const toolNames = stringArray(match.toolNames);
    if (toolNames && toolNames.length > 0 && !toolNames.includes(event.toolName ?? "")) return false;
  }
  if (match.toolIds) {
    const toolIds = stringArray(match.toolIds);
    if (toolIds && toolIds.length > 0 && !toolIds.includes(event.toolCallId ?? "")) return false;
  }
  return true;
}

/**
 * Intersect requested permissions with host-supported capabilities. Anything the
 * host does not support (clipboard, network, unknown ui verbs) is dropped, so the
 * granted set is always a subset of the request.
 */
export function grantLiveUiPermissions(
  requested: CrewCoderLiveUiPermissions,
  context: TuiLiveUiGateContext
): CrewCoderLiveUiPermissions {
  const supportedUi = new Set<CrewCoderLiveUiPermission>(["render", "input", "focus"]);
  const ui = (requested.ui ?? []).filter((capability) => supportedUi.has(capability));
  const commands = (requested.commands ?? []).filter((command) => command === "ui_response");
  const granted: CrewCoderLiveUiPermissions = { ui };
  if (commands.length) granted.commands = commands;
  if (requested.storage === "session") granted.storage = "session";
  // clipboard/network are declared in the contract but not supported by any host
  // command yet, so they are never granted.
  void context;
  return granted;
}

export function buildLiveUiProps(
  extensionId: string,
  contribution: TuiLiveUiContribution,
  event: TuiLiveUiEvent
): CrewCoderLiveUiProps {
  return {
    extensionId,
    contributionId: contribution.id,
    surface: contribution.target.surface,
    ...(contribution.target.slot === undefined ? {} : { slot: contribution.target.slot }),
    event: {
      type: event.type,
      ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
      ...(event.uiKind === undefined ? {} : { uiKind: event.uiKind }),
      ...(event.title === undefined ? {} : { title: event.title }),
      ...(event.message === undefined ? {} : { message: event.message }),
      ...(event.component === undefined ? {} : { component: event.component }),
      ...(event.metadata === undefined ? {} : { metadata: event.metadata })
    }
  };
}

export function buildLiveUiHostGrant(
  contribution: TuiLiveUiContribution,
  context: TuiLiveUiGateContext,
  limits: CrewCoderLiveUiLimits = DEFAULT_LIVE_UI_LIMITS
): CrewCoderLiveUiHost {
  return {
    protocolVersion: "0.1",
    transport: "worker-postmessage",
    permissions: grantLiveUiPermissions(contribution.permissions ?? {}, context),
    limits
  };
}

export type LiveUiSpawnPlan =
  | { allowed: false; blockedReasons: string[] }
  | { allowed: true; blockedReasons: []; props: CrewCoderLiveUiProps; host: CrewCoderLiveUiHost };

/**
 * One-shot helper the wiring layer calls when an event wants to open a live
 * component: evaluate the gate, and (only if allowed) build the immutable props
 * and granted host so `LiveUiTrustGate.spawnHost` can be called directly.
 */
export function prepareLiveUiSpawn(
  extensionId: string,
  contribution: TuiLiveUiContribution,
  event: TuiLiveUiEvent,
  context: TuiLiveUiGateContext,
  limits: CrewCoderLiveUiLimits = DEFAULT_LIVE_UI_LIMITS
): LiveUiSpawnPlan {
  const gate = evaluateTuiLiveUiGate(contribution, context);
  if (!gate.allowed) return { allowed: false, blockedReasons: gate.blockedReasons };
  return {
    allowed: true,
    blockedReasons: [],
    props: buildLiveUiProps(extensionId, contribution, event),
    host: buildLiveUiHostGrant(contribution, context, limits)
  };
}
