import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";

type Args = { worker: string; task: string; maxIterations: number };

export const delegateWorkerTool: ToolDefinition<Args> = {
  name: "delegateWorker",
  description: "Delegate a scoped subtask to another named CrewCoder worker and return the child worker's summary.",
  parameters: {
    type: "object",
    properties: {
      worker: { type: "string", description: "Existing worker name to run as the child worker." },
      task: { type: "string", description: "Specific, bounded subtask for the child worker." },
      maxIterations: { type: "integer", description: "Optional hard cap on child worker turns. Defaults to 0 (unlimited); the child is bounded by stall detection and delegation depth.", minimum: 0, maximum: 1000 }
    },
    required: ["worker", "task"],
    additionalProperties: false
  },
  executionMode: "sequential",
  parse(args) {
    const maxIterations = typeof args.maxIterations === "number" && Number.isInteger(args.maxIterations) ? args.maxIterations : 0;
    return {
      worker: String(args.worker ?? "").trim(),
      task: String(args.task ?? "").trim(),
      maxIterations: Math.min(Math.max(maxIterations, 0), 1000)
    };
  },
  async execute(args, context, signal) {
    if (!args.worker) throw new Error("delegateWorker requires a worker name.");
    if (!args.task) throw new Error("delegateWorker requires a task.");
    if (!context.delegateWorker) throw new Error("Child worker delegation is not available in this run.");
    const result = await context.delegateWorker(args, signal);
    const changed = result.mutationLog.length ? `\nChanged files:\n${[...new Set(result.mutationLog)].map((file) => `- ${file}`).join("\n")}` : "";
    return textResult(`Child worker ${result.worker} completed session ${result.sessionId}.\n\n${result.summary}${changed}`, {
      worker: result.worker,
      sessionId: result.sessionId,
      mutationLog: result.mutationLog
    });
  }
};
