// Workflow contribution point.
//
// A workflow is a deterministic, linear sequence of steps declared in an extension manifest.
// Each step is either a `tool` call with fixed arguments (no model discretion) or a `prompt`
// turn (model discretion, optionally restricted to a subset of tools).
//
// The point of the contribution is reviewability: `crewcoder workflow show <ref>` renders the
// exact plan before anything runs, so a reviewer reading a manifest diff knows what an agent
// will do. Keep this engine boring. It is not a programming language: linear steps, one guard
// form, one failure policy. Anything that wants loops or arithmetic should be a tool.

import { readConfig } from "../core/config.js";
import { getTrustTier, type TrustTier } from "../core/trust.js";
import { createToolRegistry, findTool } from "../tools/index.js";
import { runAgentLoop } from "../core/agent-loop.js";
import { listEnabledExtensions } from "./extension-registry.js";
import type { ModelClient } from "../core/model-client.js";
import type { ToolDefinition } from "../core/tool-types.js";
import type { CrewCoderExtensionWorkflowContribution, CrewCoderWorkflowStep } from "./types.js";
import { DEFAULT_AGENT_MODE } from "../core/mode-router.js";

export type WorkflowEntry = {
  /** Fully qualified reference: `ext.<extensionId>.<workflowId>`. */
  ref: string;
  extensionId: string;
  workflowId: string;
  title: string;
  description?: string;
  steps: CrewCoderWorkflowStep[];
  tier: TrustTier;
  /** True when the workflow contains tool steps, which need trusted/sandboxed. */
  hasToolSteps: boolean;
  /** True when the current tier permits running every step. */
  runnable: boolean;
};

export type WorkflowStepOutcome = {
  index: number;
  id: string;
  kind: "tool" | "prompt";
  status: "ok" | "failed" | "skipped";
  /** Text output, used for `{{steps.<id>.output}}` in later steps. */
  output: string;
  error?: string;
  /** Set for prompt steps so callers can link back to the transcript. */
  sessionId?: string;
};

export type WorkflowRunResult = {
  ref: string;
  ok: boolean;
  steps: WorkflowStepOutcome[];
  mutationLog: string[];
};

export type RunWorkflowOptions = {
  cwd?: string;
  modelClient?: ModelClient;
  providerId?: string;
  model?: string;
  sessionId?: string;
  signal?: AbortSignal;
  /** Called before each step so a CLI can stream progress. */
  onStep?: (outcome: WorkflowStepOutcome) => void;
};

export function stepId(step: CrewCoderWorkflowStep, index: number): string {
  return step.id ?? String(index + 1);
}

export async function listWorkflows(): Promise<WorkflowEntry[]> {
  const config = readConfig();
  const extensions = await listEnabledExtensions();
  const entries: WorkflowEntry[] = [];
  for (const extension of extensions) {
    const tier = getTrustTier(config, extension.manifest.id);
    for (const workflow of extension.manifest.contributes?.workflows ?? []) {
      entries.push(toEntry(extension.manifest.id, workflow, tier));
    }
  }
  return entries;
}

/** Resolve `ext.<ext>.<id>`, `<ext>.<id>`, or a bare `<id>` when it is unambiguous. */
export async function findWorkflow(ref: string): Promise<WorkflowEntry> {
  const entries = await listWorkflows();
  const normalized = ref.startsWith("ext.") ? ref.slice("ext.".length) : ref;
  const exact = entries.filter((entry) => entry.ref === ref || entry.ref === `ext.${normalized}` || `${entry.extensionId}.${entry.workflowId}` === normalized);
  if (exact.length === 1) return exact[0];
  const byId = entries.filter((entry) => entry.workflowId === normalized);
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) throw new Error(`Workflow ${ref} is ambiguous. Use one of: ${byId.map((entry) => entry.ref).join(", ")}`);
  throw new Error(`Workflow not found: ${ref}`);
}

/** Render the plan a reviewer reads before the workflow runs. */
export function describeWorkflow(entry: WorkflowEntry): string[] {
  return entry.steps.map((step, index) => {
    const guard = step.when ? ` [if ${step.when}]` : "";
    const failure = step.onFailure === "continue" ? " [continue on failure]" : "";
    const label = step.title ? ` ${step.title}` : "";
    if (step.kind === "tool") {
      const args = step.args && Object.keys(step.args).length ? ` ${JSON.stringify(step.args)}` : "";
      return `${index + 1}. [tool:${stepId(step, index)}]${label} ${step.tool}${args}${guard}${failure}`;
    }
    const allow = step.allowTools?.length ? ` (tools: ${step.allowTools.join(", ")})` : "";
    return `${index + 1}. [prompt:${stepId(step, index)}]${label} ${JSON.stringify(step.prompt)}${allow}${guard}${failure}`;
  });
}

export async function runWorkflow(ref: string, options: RunWorkflowOptions = {}): Promise<WorkflowRunResult> {
  const entry = await findWorkflow(ref);
  if (entry.hasToolSteps && !entry.runnable) {
    throw new Error(
      `Workflow ${entry.ref} contains tool steps, which execute without model review. Extension ${entry.extensionId} is ${entry.tier}. Grant access with: crewcoder extension trust ${entry.extensionId} --tier sandboxed`
    );
  }

  const cwd = options.cwd ?? process.cwd();
  const registry = createToolRegistry();
  const mutationLog: string[] = [];
  const outcomes: WorkflowStepOutcome[] = [];
  const outputs = new Map<string, WorkflowStepOutcome>();
  let ok = true;

  for (const [index, step] of entry.steps.entries()) {
    const id = stepId(step, index);
    if (!guardPasses(step.when, outputs)) {
      const skipped: WorkflowStepOutcome = { index, id, kind: step.kind, status: "skipped", output: "" };
      outcomes.push(skipped);
      outputs.set(id, skipped);
      options.onStep?.(skipped);
      continue;
    }

    const outcome = step.kind === "tool"
      ? await runToolStep(step, index, id, registry, { cwd, mutationLog, sessionId: options.sessionId ?? `workflow-${Date.now()}`, outputs, signal: options.signal })
      : await runPromptStep(step, index, id, registry, { cwd, outputs, options });

    outcomes.push(outcome);
    outputs.set(id, outcome);
    options.onStep?.(outcome);

    if (outcome.status === "failed") {
      ok = false;
      if ((step.onFailure ?? "stop") === "stop") break;
    }
  }

  return { ref: entry.ref, ok, steps: outcomes, mutationLog };
}

type ToolStepContext = {
  cwd: string;
  mutationLog: string[];
  sessionId: string;
  outputs: Map<string, WorkflowStepOutcome>;
  signal?: AbortSignal;
};

async function runToolStep(
  step: CrewCoderWorkflowStep,
  index: number,
  id: string,
  registry: ToolDefinition[],
  context: ToolStepContext
): Promise<WorkflowStepOutcome> {
  const tool = findTool(step.tool ?? "", registry);
  if (!tool) {
    return { index, id, kind: "tool", status: "failed", output: "", error: `Unknown tool: ${step.tool}` };
  }
  try {
    const args = resolveTemplates(step.args ?? {}, context.outputs) as Record<string, unknown>;
    const result = await tool.execute(tool.parse(args), {
      cwd: context.cwd,
      mode: "general",
      sessionId: context.sessionId,
      mutationLog: context.mutationLog
    }, context.signal);
    const output = result.content.map((part) => part.text).join("\n");
    // Command-running tools report failure through `details.exitCode` rather than by throwing.
    // Without this, a workflow step wrapping `npm test` would always look successful and the
    // `when`/`onFailure` guards built on top of it would be meaningless.
    const exitCode = result.details?.exitCode;
    if (typeof exitCode === "number" && exitCode !== 0) {
      return { index, id, kind: "tool", status: "failed", output, error: `${step.tool} exited with ${exitCode}` };
    }
    return { index, id, kind: "tool", status: "ok", output };
  } catch (error) {
    return { index, id, kind: "tool", status: "failed", output: "", error: error instanceof Error ? error.message : String(error) };
  }
}

async function runPromptStep(
  step: CrewCoderWorkflowStep,
  index: number,
  id: string,
  registry: ToolDefinition[],
  context: { cwd: string; outputs: Map<string, WorkflowStepOutcome>; options: RunWorkflowOptions }
): Promise<WorkflowStepOutcome> {
  const prompt = String(resolveTemplates(step.prompt ?? "", context.outputs));
  const tools = step.allowTools?.length ? registry.filter((tool) => step.allowTools?.includes(tool.name)) : undefined;
  if (step.allowTools?.length && tools?.length !== step.allowTools.length) {
    const known = new Set(registry.map((tool) => tool.name));
    const missing = step.allowTools.filter((name) => !known.has(name));
    return { index, id, kind: "prompt", status: "failed", output: "", error: `Unknown tools in allowTools: ${missing.join(", ")}` };
  }
  try {
    const result = await runAgentLoop(
      { prompt, requestedMode: DEFAULT_AGENT_MODE, cwd: context.cwd },
      {
        modelClient: context.options.modelClient,
        providerId: context.options.providerId,
        model: context.options.model,
        tools,
        signal: context.options.signal
      }
    );
    if (result.providerError) return { index, id, kind: "prompt", status: "failed", output: "", error: result.providerError, sessionId: result.sessionId };
    if (result.stallError) return { index, id, kind: "prompt", status: "failed", output: result.summary, error: result.stallError, sessionId: result.sessionId };
    return { index, id, kind: "prompt", status: "ok", output: result.summary, sessionId: result.sessionId };
  } catch (error) {
    return { index, id, kind: "prompt", status: "failed", output: "", error: error instanceof Error ? error.message : String(error) };
  }
}

function guardPasses(when: string | undefined, outputs: Map<string, WorkflowStepOutcome>): boolean {
  if (!when) return true;
  const match = /^steps\.(?<id>[A-Za-z0-9._-]+)\.(?<state>ok|failed)$/.exec(when);
  if (!match?.groups) return false;
  const outcome = outputs.get(match.groups.id);
  // An unreached or skipped step satisfies neither `.ok` nor `.failed`.
  if (!outcome || outcome.status === "skipped") return false;
  return match.groups.state === "ok" ? outcome.status === "ok" : outcome.status === "failed";
}

const templatePattern = /\{\{\s*steps\.([A-Za-z0-9._-]+)\.output\s*\}\}/g;

function resolveTemplates(value: unknown, outputs: Map<string, WorkflowStepOutcome>): unknown {
  if (typeof value === "string") {
    return value.replace(templatePattern, (_match, id: string) => outputs.get(id)?.output ?? "");
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, outputs));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveTemplates(item, outputs)]));
  }
  return value;
}

function toEntry(extensionId: string, workflow: CrewCoderExtensionWorkflowContribution, tier: TrustTier): WorkflowEntry {
  const hasToolSteps = workflow.steps.some((step) => step.kind === "tool");
  return {
    ref: `ext.${extensionId}.${workflow.id}`,
    extensionId,
    workflowId: workflow.id,
    title: workflow.title,
    description: workflow.description,
    steps: workflow.steps,
    tier,
    hasToolSteps,
    // Prompt-only workflows are safe at any tier: the agent's own approval gates still apply.
    // Tool steps bypass model judgement, so they need the same tier as extension tools.
    runnable: !hasToolSteps || tier === "trusted" || tier === "sandboxed"
  };
}
