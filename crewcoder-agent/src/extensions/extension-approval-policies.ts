import { readConfig } from "../core/config.js";
import type { ApprovalRisk } from "../core/events.js";
import type { ToolCallPart } from "../core/messages.js";
import { listEnabledExtensions } from "./extension-registry.js";
import type { CrewCoderExtensionApprovalPolicyContribution, LoadedCrewCoderExtension } from "./types.js";
import { hasAnyMatcher, matchesToolCall } from "./tool-call-matcher.js";

export type ExtensionApprovalPolicyAction = "allow" | "review" | "block";

export type LoadedExtensionApprovalPolicy = {
  extensionId: string;
  policyId: string;
  title: string;
  action: ExtensionApprovalPolicyAction;
  reason?: string;
  tools: string[];
  paths: string[];
  commands: string[];
};

export type ExtensionApprovalPolicyDecision =
  | { action: "allow" }
  | { action: "review"; risk: ApprovalRisk; reason: string }
  | { action: "block"; risk: ApprovalRisk; reason: string };

export async function loadTrustedExtensionApprovalPolicies(): Promise<LoadedExtensionApprovalPolicy[]> {
  const config = readConfig();
  if (!config.allowExtensionHooks) return [];
  const trusted = new Set(config.trustedExtensions);
  if (trusted.size === 0) return [];
  const extensions = await listEnabledExtensions();
  return extensions
    .filter((extension) => trusted.has(extension.manifest.id))
    .flatMap(extensionApprovalPoliciesFromManifest);
}

export function extensionApprovalPoliciesFromManifest(extension: LoadedCrewCoderExtension): LoadedExtensionApprovalPolicy[] {
  return (extension.manifest.contributes?.approvalPolicies ?? []).flatMap((policy) => {
    if (!isPolicy(policy)) return [];
    return [{
      extensionId: extension.manifest.id,
      policyId: policy.id,
      title: policy.title,
      action: policy.action,
      reason: policy.reason,
      tools: policy.tools ?? [],
      paths: policy.paths ?? [],
      commands: policy.commands ?? []
    }];
  });
}

export function evaluateExtensionApprovalPolicies(policies: LoadedExtensionApprovalPolicy[], toolCall: ToolCallPart): ExtensionApprovalPolicyDecision {
  let review: { risk: ApprovalRisk; reason: string } | undefined;
  for (const policy of policies) {
    if (!policyMatches(policy, toolCall)) continue;
    const reason = policy.reason?.trim() || `${policy.title} matched ${toolCall.name}`;
    const tagged = `[${policy.extensionId}/${policy.policyId}] ${reason}`;
    if (policy.action === "block") return { action: "block", risk: "dangerous", reason: tagged };
    if (policy.action === "review") review = { risk: "review", reason: tagged };
  }
  return review ? { action: "review", ...review } : { action: "allow" };
}

function isPolicy(value: unknown): value is CrewCoderExtensionApprovalPolicyContribution {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" && typeof record.title === "string" && (record.action === "allow" || record.action === "review" || record.action === "block");
}

function policyMatches(policy: LoadedExtensionApprovalPolicy, toolCall: ToolCallPart): boolean {
  const matchers = { tools: policy.tools, paths: policy.paths, commands: policy.commands };
  // A policy that declares no matchers must never match, otherwise it would silently apply
  // to every tool call.
  return hasAnyMatcher(matchers) && matchesToolCall(matchers, toolCall);
}
