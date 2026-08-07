import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { rememberFact } from "../core/memory-store.js";

type Args = { fact: string; topic?: string };

export const rememberTool: ToolDefinition<Args> = {
  name: "remember",
  description: "Persist a durable fact to repo-shareable cross-session memory (.crewcoder/memory/<topic>.md). Use for stable project facts, conventions, or decisions that future sessions should honor. Do not store secrets.",
  parameters: {
    type: "object",
    properties: {
      fact: { type: "string", description: "The fact or note to remember." },
      topic: { type: "string", description: "Optional topic file to group the note under (default: memory)." }
    },
    required: ["fact"],
    additionalProperties: false
  },
  executionMode: "sequential",
  parse(args) {
    if (typeof args.fact !== "string" || !args.fact.trim()) throw new Error("remember requires a non-empty 'fact'.");
    return { fact: args.fact, topic: typeof args.topic === "string" ? args.topic : undefined };
  },
  async execute(args, context) {
    const entry = rememberFact(context.cwd, args.fact, { topic: args.topic });
    return textResult(`Remembered under "${entry.topic}" (id ${entry.id}): ${entry.text}`, { id: entry.id, topic: entry.topic, file: entry.file });
  }
};
