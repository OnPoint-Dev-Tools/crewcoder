import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import {
  CREWCODER_CLARIFY_TOOL,
  CREWCODER_PROPOSE_PLAN_TOOL,
  recordClarification,
  recordProposedPlan
} from "./crewcoder-workflow.js";

type ClarifyArgs = { questions: string[] };
type ProposePlanArgs = { requirements: string; plan: string; acceptanceCriteria: string };

export const crewcoderClarifyTool: ToolDefinition<ClarifyArgs> = {
  name: CREWCODER_CLARIFY_TOOL,
  description: "Required CrewCoder-mode step. Ask the user at least one clarification or confirmation question, then stop. Mutations stay blocked until this tool has been used, the user has answered, a plan is proposed, and the user approves that plan.",
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
  description: "Required CrewCoder-mode step after clarification. Lock the requirements and propose the implementation plan, then stop and wait for explicit user approval. An earlier request to implement does not count as approval.",
  parameters: {
    type: "object",
    properties: {
      requirements: {
        type: "string",
        description: "Restated goal, scope, exclusions, decisions, and assumptions."
      },
      plan: {
        type: "string",
        description: "Ordered implementation plan with likely files or system areas."
      },
      acceptanceCriteria: {
        type: "string",
        description: "Measurable checks that prove the work is done."
      }
    },
    required: ["requirements", "plan", "acceptanceCriteria"],
    additionalProperties: false
  },
  executionMode: "sequential",
  parse(args) {
    return {
      requirements: String(args.requirements ?? "").trim(),
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
    const next = recordProposedPlan(context.crewcoderWorkflow, args);
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
          args.plan,
          "",
          "Acceptance criteria:",
          args.acceptanceCriteria,
          "",
          "Approve with /approve-plan, or reply approve. Describe revisions instead of approving if this plan is wrong."
        ].join("\n"),
        { requirements: args.requirements, plan: args.plan, acceptanceCriteria: args.acceptanceCriteria, phase: next.phase }
      ),
      terminate: true
    };
  }
};

export function createCrewcoderWorkflowTools(): ToolDefinition[] {
  return [crewcoderClarifyTool, crewcoderProposePlanTool];
}
