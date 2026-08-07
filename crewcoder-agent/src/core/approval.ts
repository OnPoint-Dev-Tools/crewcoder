import type { ApprovalRisk } from "./events.js";
import type { ToolDefinition } from "./tool-types.js";

export type ApprovalMode = "never" | "review" | "always" | "full-access" | "sandboxed";

export type ApprovalDecision = {
  required: boolean;
  approved: boolean;
  risk: ApprovalRisk;
  reason: string;
};

export function riskForTool(tool: ToolDefinition | undefined, args: Record<string, unknown>): ApprovalRisk {
  if (!tool) return "review";
  if (tool.name === "bash") return riskForBash(String(args.command ?? ""));
  if (tool.isMutation) return "review";
  return "safe";
}

export function decideApproval(input: {
  approvalMode: ApprovalMode;
  tool: ToolDefinition | undefined;
  args: Record<string, unknown>;
}): ApprovalDecision {
  const risk = riskForTool(input.tool, input.args);
  const reason = approvalReason(input.tool?.name ?? "unknown", risk, input.args);

  if (input.approvalMode === "full-access") {
    return { required: false, approved: true, risk, reason };
  }

  if (input.approvalMode === "never") {
    return { required: false, approved: risk !== "dangerous", risk, reason };
  }

  // Sandboxed runs without interactive prompts because the blast radius is contained
  // by the OS-level sandbox; still refuse commands flagged outright dangerous.
  if (input.approvalMode === "sandboxed") {
    return { required: false, approved: risk !== "dangerous", risk, reason };
  }

  if (input.approvalMode === "always") {
    return { required: risk !== "safe", approved: false, risk, reason };
  }

  return { required: risk === "review" || risk === "dangerous", approved: false, risk, reason };
}

export function approvalReason(toolName: string, risk: ApprovalRisk, args: Record<string, unknown>): string {
  if (toolName === "bash") return `Command requires review (${risk}): ${String(args.command ?? "")}`;
  if (risk === "review") return `${toolName} may modify project files.`;
  if (risk === "dangerous") return `${toolName} appears dangerous and should not run without explicit approval.`;
  return `${toolName} is read-only or low risk.`;
}

function riskForBash(command: string): ApprovalRisk {
  const lower = command.toLowerCase();
  const dangerous = ["rm -rf", "mkfs", "dd if=", "shutdown", "reboot", "chmod -r 777", "chown -r"];
  if (dangerous.some((token) => lower.includes(token))) return "dangerous";
  const review = ["rm ", "mv ", "cp ", "git reset", "git clean", "npm install", "pnpm install", "cargo install", "curl ", "wget ", "sudo"];
  if (review.some((token) => lower.includes(token))) return "review";
  return "safe";
}
