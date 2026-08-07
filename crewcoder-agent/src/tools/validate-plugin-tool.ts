import path from "node:path";
import type { ToolDefinition } from "../core/tool-types.js";
import { textResult } from "../core/tool-types.js";
import { validatePlugin } from "./validate-plugin.js";
import { resolveInsideCwd } from "./path-utils.js";
type Args = { path: string };
export const validatePluginTool: ToolDefinition<Args> = { name: "validatePlugin", description: "Validate a CrewCode plugin directory against v0 guardrails.", parameters: { type: "object", properties: { path: { type: "string", description: "Workspace-relative plugin directory or absolute directory inside a session external root." } }, required: ["path"], additionalProperties: false }, executionMode: "sequential", parse(args) { return { path: String(args.path ?? ".") }; }, async execute(args, context) { const dir = resolveInsideCwd(context.cwd, args.path, context.externalDirectories); const result = validatePlugin(dir); const lines = [result.ok ? "Plugin validation passed." : "Plugin validation failed.", ...result.errors.map((error) => `error: ${error}`), ...result.warnings.map((warning) => `warning: ${warning}`)]; return textResult(lines.join("\n"), { ok: result.ok, errors: result.errors, warnings: result.warnings, path: path.relative(context.cwd, dir) || "." }); } };
