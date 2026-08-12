import type { ToolDefinition } from "../core/tool-types.js";
import { backgroundJobTool } from "./background-job.js";
import { bashTool } from "./bash.js";
import { createPluginTool } from "./create-plugin-tool.js";
import { createExtensionTool } from "./create-extension-tool.js";
import { delegateWorkerTool } from "./delegate-worker.js";
import { editTool } from "./edit.js";
import { editSymbolTool } from "./edit-symbol.js";
import { editTransactionTool } from "./edit-transaction.js";
import { gitBlameTool, gitCherryPickTool, gitDiffRangeTool, gitLogTool } from "./git-primitives.js";
import { grepTool } from "./grep.js";
import { lspDefinitionTool, lspDiagnosticsTool, lspHoverTool } from "./lsp.js";
import { listFilesTool } from "./list-files.js";
import { listTemplatesTool } from "./list-templates-tool.js";
import { createDocsTool } from "./docs.js";
import { readTool } from "./read.js";
import { rememberTool } from "./remember.js";
import { validatePluginTool } from "./validate-plugin-tool.js";
import { writeTool } from "./write.js";
import { createCrewTaskTools } from "../crew-tasks/tools.js";
import type { IntegrationProfile } from "../core/integration-profile.js";
import type { ResolvedAgentMode } from "../core/types.js";

export function createToolRegistry(
  profile: IntegrationProfile = "standalone",
  mode: ResolvedAgentMode = "general",
): ToolDefinition[] {
  const core = [listFilesTool, readTool, grepTool, writeTool, editTool, editSymbolTool, editTransactionTool, gitBlameTool, gitLogTool, gitDiffRangeTool, gitCherryPickTool, lspDefinitionTool, lspHoverTool, lspDiagnosticsTool, bashTool, backgroundJobTool, delegateWorkerTool, rememberTool, ...createCrewTaskTools()];
  if (mode === "extension") return [...core, createExtensionTool, createDocsTool(profile, mode)];
  if (mode === "plugin" && profile === "crewcode") return [...core, createDocsTool(profile, mode), createPluginTool, validatePluginTool, listTemplatesTool];
  return core;
}
export function findTool(name: string, tools: ToolDefinition[]): ToolDefinition | undefined { return tools.find((tool) => tool.name === name); }
