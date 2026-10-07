import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import {
  CREWCODER_CLARIFY_TOOL,
  CREWCODER_PROPOSE_PLAN_TOOL,
  recordClarification,
  recordProposedPlan
} from "./crewcoder-workflow.js";

type ClarifyArgs = { questions: string[] };
type PlannedFileChange = { path: string; action: "modify" | "create" | "delete"; description: string; snippet: string };
type ProposePlanArgs = { requirements: string; investigation: string; fileChanges: PlannedFileChange[]; plan: string; acceptanceCriteria: string };

export const crewcoderClarifyTool: ToolDefinition<ClarifyArgs> = {
  name: CREWCODER_CLARIFY_TOOL,
  description: "Required CrewCoder-mode step. Inspect relevant code first, then ask the user at least one grounded clarification or confirmation question and stop. Mutations stay blocked until this tool has been used, the user has answered, a plan is proposed, and the user approves that plan.",
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: { type: "string" },
        description: "One to five questions that actually change the result. Batch related decisions."
      }
    },
    required: ["questions"],
    additionalProperties: false
  },
  executionMode: "sequential",
  parse(args) {
    const questions = Array.isArray(args.questions)
      ? args.questions.map((item) => String(item).trim()).filter(Boolean)
      : [];
    return { questions };
  },
  async execute(args, context) {
    if (context.mode !== "crewcoder") throw new Error("crewcoder_clarify is only available in crewcoder mode.");
    if (!context.crewcoderWorkflow) throw new Error("CrewCoder workflow state is missing.");
    if (args.questions.length === 0) throw new Error("crewcoder_clarify requires at least one question.");
    const next = recordClarification(context.crewcoderWorkflow, args.questions);
    context.crewcoderWorkflow.phase = next.phase;
    context.crewcoderWorkflow.questions = next.questions;
    const numbered = args.questions.map((question, index) => `${index + 1}. ${question}`).join("\n");
    return {
      ...textResult(
        `Clarification required before a plan can be proposed.\n\n${numbered}\n\nReply with answers. Implementation stays blocked.`,
        { questions: args.questions, phase: next.phase }
      ),
      terminate: true
    };
  }
};

export const crewcoderProposePlanTool: ToolDefinition<ProposePlanArgs> = {
  name: CREWCODER_PROPOSE_PLAN_TOOL,
  description: "Call only after clarification answers and sufficient read-only investigation to understand the implementation. Present findings, exact file changes and representative code snippets, ordered steps, risks, and validation; then stop for explicit user approval. Do not propose a plan whose first step is to discover how the project works. An earlier request to implement does not count as approval.",
  parameters: {
    type: "object",
    properties: {
      requirements: {
        type: "string",
        description: "Restated goal, scope, exclusions, decisions, and assumptions."
      },
      plan: {
        type: "string",
        description: "Ordered implementation steps grounded in inspected code, with integration details and material risks. Resolve architectural unknowns before proposing."
      },
      investigation: {
        type: "string",
        description: "Relevant files read, current behavior and root cause or integration points, existing patterns and tests, and remaining assumptions. For an empty project, explain the inspected directory and chosen structure."
      },
      fileChanges: {
        type: "array",
        description: "Every planned file to modify, create, or delete, including tests and documentation, with its purpose and representative proposed code or diff. Use [] only when the deliverable requires no file changes and explain why in the plan.",
        items: {
          type: "object",
          properties: {
            path: { type: "string", description: "Exact project-relative file path." },
            action: { type: "string", enum: ["modify", "create", "delete"] },
            description: { type: "string", description: "What changes and why, tied to inspected code." },
            snippet: { type: "string", description: "Representative proposed code or diff; for deletion, show the code or content being removed." }
          },
          required: ["path", "action", "description", "snippet"],
          additionalProperties: false
        }
      },
      acceptanceCriteria: {
        type: "string",
        description: "Measurable checks that prove the work is done."
      }
    },
    required: ["requirements", "investigation", "fileChanges", "plan", "acceptanceCriteria"],
    additionalProperties: false
  },
  executionMode: "sequential",
  parse(args) {
    if (!Array.isArray(args.fileChanges) || args.fileChanges.length > 100) {
      throw new Error("fileChanges must be an array of at most 100 concrete file changes; use [] for a deliverable requiring no file changes.");
    }
    const fileChanges = args.fileChanges.map((value: unknown): PlannedFileChange => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each fileChanges entry must be an object.");
      const entry = value as Record<string, unknown>;
      const { action } = entry;
      if (action !== "modify" && action !== "create" && action !== "delete") throw new Error("File action must be modify, create, or delete.");
      for (const key of ["path", "description", "snippet"] as const) {
        if (typeof entry[key] !== "string" || !entry[key].trim()) throw new Error(`Each file change requires a non-empty ${key}.`);
      }
      return { path: String(entry.path).trim(), action, description: String(entry.description).trim(), snippet: String(entry.snippet).trim() };
    });
    for (const key of ["requirements", "investigation", "plan", "acceptanceCriteria"] as const) {
      if (typeof args[key] !== "string" || !args[key].trim()) throw new Error(`${key} is required and must be a non-empty string.`);
    }
    return {
      requirements: String(args.requirements ?? "").trim(),
      investigation: String(args.investigation).trim(),
      fileChanges,
      plan: String(args.plan ?? "").trim(),
      acceptanceCriteria: String(args.acceptanceCriteria ?? "").trim()
    };
  },
  async execute(args, context) {
    if (context.mode !== "crewcoder") throw new Error("crewcoder_propose_plan is only available in crewcoder mode.");
    if (!context.crewcoderWorkflow) throw new Error("CrewCoder workflow state is missing.");
    if (!args.requirements) throw new Error("requirements is required.");
    if (!args.plan) throw new Error("plan is required.");
    if (!args.acceptanceCriteria) throw new Error("acceptanceCriteria is required.");
    const filePreview = args.fileChanges.map((change) => [
      `${change.action}: ${change.path}`,
      change.description,
      "```",
      change.snippet,
      "```"
    ].join("\n")).join("\n\n");
    const plan = [
      "Investigation findings:", args.investigation,
      "", "Planned file changes:", filePreview || "No file changes proposed.",
      "", "Implementation steps and risks:", args.plan
    ].join("\n");
    const next = recordProposedPlan(context.crewcoderWorkflow, { ...args, plan });
    context.crewcoderWorkflow.phase = next.phase;
    context.crewcoderWorkflow.requirements = next.requirements;
    context.crewcoderWorkflow.plan = next.plan;
    context.crewcoderWorkflow.acceptanceCriteria = next.acceptanceCriteria;
    return {
      ...textResult(
        [
          "Plan proposed. Implementation is still blocked until you approve this specific plan.",
          "",
          "Requirements:",
          args.requirements,
          "",
          "Plan:",
          plan,
          "",
          "Acceptance criteria:",
          args.acceptanceCriteria,
          "",
          "Approve with /approve-plan, or reply approve. Describe revisions instead of approving if this plan is wrong."
        ].join("\n"),
        { requirements: args.requirements, investigation: args.investigation, fileChanges: args.fileChanges, plan, acceptanceCriteria: args.acceptanceCriteria, phase: next.phase }
      ),
      terminate: true
    };
  }
};

export function createCrewcoderWorkflowTools(): ToolDefinition[] {
  return [crewcoderClarifyTool, crewcoderProposePlanTool];
}
