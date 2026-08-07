import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import type { PluginKind } from "../core/types.js";
import { createPlugin, isSupportedPluginKind } from "../generators/plugin-generator.js";
import { resolveInsideCwd } from "./path-utils.js";
type Args = { id: string; kind: PluginKind; out: string; };
export const createPluginTool: ToolDefinition<Args> = {
  name: "createPlugin",
  description: "Generate a CrewCode plugin starter. Prefers real templates from /CrewCode/examples/plugins when available.",
  parameters: { type: "object", properties: { id: { type: "string", description: "Plugin id / directory name to create." }, kind: { type: "string", description: "CrewCode plugin starter kind.", enum: ["static-panel", "typescript-panel", "repo-indexer", "workspace-writer", "mock-agent", "http-agent", "openai-agent", "exec-agent", "mcp", "browser-action", "git-lens", "mission-widget"] }, out: { type: "string", description: "Workspace-relative output directory or absolute directory inside a session external root." } }, required: ["id", "kind"], additionalProperties: false },
  executionMode: "sequential",
  isMutation: true,
  parse(args) {
    const kind = String(args.kind ?? "") as PluginKind;
    if (!isSupportedPluginKind(kind)) throw new Error("Unsupported plugin kind. Use listPluginTemplates to see supported kinds.");
    return { id: String(args.id ?? ""), kind, out: typeof args.out === "string" ? args.out : "." };
  },
  async execute(args, context) {
    if (!args.id) throw new Error("id is required");
    const files = await createPlugin(args.id, args.kind, resolveInsideCwd(context.cwd, args.out, context.externalDirectories));
    for (const file of files) context.mutationLog.push(`${args.id}/${file}`);
    return textResult(`Created ${args.kind} plugin ${args.id}\n${files.map((file) => `- ${file}`).join("\n")}`, { id: args.id, kind: args.kind, files });
  }
};
