import type { JsonObjectSchema, ToolDefinition } from "./tool-types.js";

export function toolParameters(tool: Pick<ToolDefinition, "parameters">): JsonObjectSchema {
  return tool.parameters ?? { type: "object", additionalProperties: true };
}
