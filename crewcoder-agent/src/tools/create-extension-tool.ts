import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { createCrewCoderExtension } from "../generators/extension-generator.js";

type Args = { id: string };

export const createExtensionTool: ToolDefinition<Args> = {
  name: "createCrewCoderExtension",
  description: "Create a capability-based CrewCoder agent extension package under /.crewcoder/extensions.",
  parameters: { type: "object", properties: { id: { type: "string", description: "Extension id / directory name to create." } }, required: ["id"], additionalProperties: false },
  executionMode: "sequential",
  isMutation: true,
  parse(args) {
    return { id: String(args.id ?? "") };
  },
  async execute(args, context) {
    if (!args.id) throw new Error("id is required");
    const files = await createCrewCoderExtension(args.id);
    for (const file of files) context.mutationLog.push(`/.crewcoder/extensions/${args.id}/${file}`);
    return textResult(`Created CrewCoder extension ${args.id}\n${files.map((file) => `- ${file}`).join("\n")}`, { id: args.id, files });
  }
};
