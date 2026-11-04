import type { ToolDefinition } from "./tool-types.js";

export type ToolMode = "crewcoder" | "native";

export function isToolMode(value: unknown): value is ToolMode {
  return value === "crewcoder" || value === "native";
}

export function resolveToolMode(preference: ToolMode | "legacy", input: {
  hostedToolsOnly?: boolean;
  virtualFilesystem?: boolean;
  suppliedTools?: ToolDefinition[];
  additionalTools?: ToolDefinition[];
  mode: string;
}): ToolMode | undefined {
  // Host custody and the approved-plan workflow cannot be bypassed by user preferences.
  if (input.hostedToolsOnly || input.virtualFilesystem || input.suppliedTools || input.additionalTools?.length || input.mode !== "general") return "crewcoder";
  return preference === "legacy" ? undefined : preference;
}
