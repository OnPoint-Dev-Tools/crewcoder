import { getText, type AgentMessage } from "../core/messages.js";
import type { ToolDefinition } from "../core/tool-types.js";

export const CREWCODER_CLARIFY_TOOL = "crewcoder_clarify";
export const CREWCODER_PROPOSE_PLAN_TOOL = "crewcoder_propose_plan";

export type CrewcoderWorkflowPhase =
  | "inspect"
  | "awaiting_answers"
  | "awaiting_plan"
  | "awaiting_approval"
  | "approved";

export type CrewcoderWorkflowState = {
  phase: CrewcoderWorkflowPhase;
  questions: string[];
  requirements: string;
  plan: string;
  acceptanceCriteria: string;
};

const WORKFLOW_TOOLS = new Set([CREWCODER_CLARIFY_TOOL, CREWCODER_PROPOSE_PLAN_TOOL]);
const ALWAYS_MUTATING_TOOLS = new Set([
  "bash",
  "background_job",
  "delegateWorker",
  "remember"
]);

const APPROVAL_MESSAGE_RE = /^(?:\/approve-plan|approve-plan|approve(?:d)?|lgtm|looks good(?: to me)?|go(?: ahead)?|do it|ship it|yes|y|ok(?:ay)?)\.?$/i;

const READ_ONLY_COMMANDS = new Set([
  "ls", "dir", "cat", "head", "tail", "less", "more", "find", "grep", "egrep", "fgrep",
  "rg", "ag", "ack", "wc", "stat", "file", "pwd", "whoami", "which", "type", "echo",
  "printf", "true", "false", "test", "[", "env", "printenv", "date", "uname", "id",
  "hostname", "realpath", "readlink", "dirname", "basename", "tree"
]);

const READ_ONLY_GIT = new Set([
  "status", "log", "diff", "show", "blame", "rev-parse", "describe", "ls-files",
  "ls-tree", "cat-file", "remote", "branch", "grep", "name-rev", "shortlog",
  "version", "help", "config"
]);

const MUTATING_TOKENS = [
  ">", ">>", "tee ", "sed -i", "mkdir", "rmdir", "touch", "chmod", "chown", "ln ",
  "install ", "truncate", "npm i", "npm install", "npx create", "pnpm add", "pnpm i",
  "yarn add", "pip install", "cargo install"
];

export function emptyCrewcoderWorkflow(): CrewcoderWorkflowState {
  return {
    phase: "inspect",
    questions: [],
    requirements: "",
    plan: "",
    acceptanceCriteria: ""
  };
}

export function cloneCrewcoderWorkflow(state: CrewcoderWorkflowState): CrewcoderWorkflowState {
  return {
    phase: state.phase,
    questions: [...state.questions],
    requirements: state.requirements,
    plan: state.plan,
    acceptanceCriteria: state.acceptanceCriteria
  };
}

export function isPlanApprovalMessage(text: string): boolean {
  return APPROVAL_MESSAGE_RE.test(text.trim());
}

export function applyIncomingUserMessage(state: CrewcoderWorkflowState, text: string): CrewcoderWorkflowState {
  const next = cloneCrewcoderWorkflow(state);
  if (next.phase === "awaiting_answers") {
    next.phase = "awaiting_plan";
    return next;
  }
  if (next.phase === "awaiting_approval") {
    next.phase = isPlanApprovalMessage(text) ? "approved" : "awaiting_plan";
    return next;
  }
  return next;
}

export function reconstructCrewcoderWorkflow(messages: readonly AgentMessage[]): CrewcoderWorkflowState {
  let state = emptyCrewcoderWorkflow();
  for (const message of messages) {
    if (message.role === "toolResult" && !message.isError) {
      if (message.toolName === CREWCODER_CLARIFY_TOOL) {
        state = {
          ...state,
          phase: "awaiting_answers",
          questions: stringList(message.details?.questions) || state.questions
        };
        continue;
      }
      if (message.toolName === CREWCODER_PROPOSE_PLAN_TOOL) {
        state = {
          ...state,
          phase: "awaiting_approval",
          requirements: stringValue(message.details?.requirements) || state.requirements,
          plan: stringValue(message.details?.plan) || state.plan,
          acceptanceCriteria: stringValue(message.details?.acceptanceCriteria) || state.acceptanceCriteria
        };
        continue;
      }
    }
    if (message.role === "user") state = applyIncomingUserMessage(state, getText(message));
  }
  return state;
}

export function recordClarification(state: CrewcoderWorkflowState, questions: string[]): CrewcoderWorkflowState {
  return {
    ...cloneCrewcoderWorkflow(state),
    phase: "awaiting_answers",
    questions
  };
}

export function recordProposedPlan(
  state: CrewcoderWorkflowState,
  input: { requirements: string; plan: string; acceptanceCriteria: string }
): CrewcoderWorkflowState {
  if (state.phase === "inspect") {
    throw new Error("Call crewcoder_clarify and wait for the user's answers before proposing a plan.");
  }
  if (state.phase === "awaiting_answers") {
    throw new Error("Wait for the user to answer your crewcoder_clarify questions before proposing a plan.");
  }
  return {
    ...cloneCrewcoderWorkflow(state),
    phase: "awaiting_approval",
    requirements: input.requirements,
    plan: input.plan,
    acceptanceCriteria: input.acceptanceCriteria
  };
}

export function formatCrewcoderWorkflowPrompt(state: CrewcoderWorkflowState): string {
  const mutations = state.phase === "approved"
    ? "Mutating tools are unlocked for the approved plan."
    : "Mutating tools are blocked. Read-only inspection is allowed.";
  const next =
    state.phase === "inspect" ? "Call crewcoder_clarify with at least one question or confirmation. Do not implement."
    : state.phase === "awaiting_answers" ? "Stop and wait. The user has not answered yet."
    : state.phase === "awaiting_plan" ? "Restate the locked requirements and call crewcoder_propose_plan. Do not implement."
    : state.phase === "awaiting_approval" ? "Stop and wait. Ask the user to approve this specific plan with /approve-plan or a clear approval."
    : "Implement the approved plan. Re-propose if scope changes.";
  return [
    "CrewCoder workflow gate (runtime-enforced):",
    `Current phase: ${state.phase}`,
    mutations,
    next,
    "You must use crewcoder_clarify then crewcoder_propose_plan in order. Free-text questions do not unlock implementation."
  ].join("\n");
}

export function crewcoderMutationBlockReason(
  tool: ToolDefinition | undefined,
  args: Record<string, unknown>,
  state: CrewcoderWorkflowState | undefined
): string | undefined {
  if (!state || state.phase === "approved") return undefined;
  const name = tool?.name ?? "unknown";
  if (WORKFLOW_TOOLS.has(name)) return undefined;
  if (!toolMutatesBeforePlan(tool, args)) return undefined;
  const next =
    state.phase === "inspect" ? "Call crewcoder_clarify first."
    : state.phase === "awaiting_answers" ? "Wait for the user to answer your questions."
    : state.phase === "awaiting_plan" ? "Call crewcoder_propose_plan and wait for explicit approval."
    : "Wait for the user to approve the current plan with /approve-plan or a clear approval.";
  return `CrewCoder mode blocked ${name} until the plan is approved (phase: ${state.phase}). ${next}`;
}

export function isReadOnlyDiscoveryCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (MUTATING_TOKENS.some((token) => lower.includes(token))) return false;
  if (/[0-9]?>/.test(lower) || lower.includes(">>")) return false;
  return splitShellCommands(trimmed).every(isReadOnlySegment);
}

function toolMutatesBeforePlan(tool: ToolDefinition | undefined, args: Record<string, unknown>): boolean {
  if (!tool) return true;
  if (tool.isMutation) return true;
  if (!ALWAYS_MUTATING_TOOLS.has(tool.name)) return false;
  if (tool.name === "bash") return !isReadOnlyDiscoveryCommand(String(args.command ?? ""));
  if (tool.name === "background_job") return args.action !== "status";
  return true;
}

function splitShellCommands(command: string): string[] {
  return command.split(/\s*(?:&&|\|\||;|\n)\s*/).map((part) => part.trim()).filter(Boolean);
}

function isReadOnlySegment(segment: string): boolean {
  const tokens = tokenize(segment);
  const command = stripEnvAssignments(tokens);
  if (command.length === 0) return false;
  const bin = pathBase(command[0] ?? "").toLowerCase();
  if (bin === "git") {
    const sub = (command[1] ?? "").toLowerCase();
    if (!READ_ONLY_GIT.has(sub)) return false;
    if (sub === "branch" && command.some((token) => /^-[dDmM]/.test(token) || token === "--delete" || token === "--move")) return false;
    if (sub === "config" && command.some((token) => token === "--unset" || token === "--add" || token === "--replace-all")) return false;
    return !command.includes("-i") && !command.some((token) => token.startsWith("--edit"));
  }
  return READ_ONLY_COMMANDS.has(bin);
}

function stripEnvAssignments(tokens: string[]): string[] {
  let index = 0;
  while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index += 1;
  return tokens.slice(index);
}

function tokenize(segment: string): string[] {
  const pipe = segment.split("|")[0] ?? segment;
  return pipe.trim().split(/\s+/).filter(Boolean);
}

function pathBase(command: string): string {
  const normalized = command.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash === -1 ? normalized : normalized.slice(slash + 1);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
