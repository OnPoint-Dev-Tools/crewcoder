import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { listTemplates } from "../generators/template-registry.js";
type Args = { path?: string; };
export const listTemplatesTool: ToolDefinition<Args> = {
  name: "listPluginTemplates",
  description: "List CrewCode plugin templates discovered from /CrewCode/examples/plugins or repo-local examples/plugins.",
  parameters: { type: "object", properties: { path: { type: "string", description: "Workspace-relative path used for template discovery." } }, additionalProperties: false },
  executionMode: "parallel",
  parse(args) { return { path: typeof args.path === "string" ? args.path : undefined }; },
  async execute(args, context) {
    const templates = listTemplates(args.path ?? context.cwd);
    return textResult(templates.map((template) => `${template.kind} -> ${template.templateName} (${template.available ? "available" : "fallback"})`).join("\n"), { templates });
  }
};
