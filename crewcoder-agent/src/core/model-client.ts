import { spawn } from "node:child_process";
import { ProviderModelClient } from "../providers/provider-model-client.js";
import type { AgentMessage, AssistantMessage, ToolCallPart, ToolResultMessage } from "./messages.js";
import { assistantText, getText } from "./messages.js";
import type { JsonObjectSchema } from "./tool-types.js";
import type { ModelUsage } from "./usage.js";
export type ModelSessionContext = { sessionId: string; resumeFromSessionId?: string; continuation: boolean; providerSessionId?: string };
export type ModelInput = { systemPrompt: string; messages: AgentMessage[]; externalDirectories?: string[]; useProviderNativeFileTools?: boolean; availableTools: Array<{ name: string; description: string; parameters?: JsonObjectSchema }>; session?: ModelSessionContext };
export type ModelStreamCallbacks = {
  onAssistantDelta?(text: string): Promise<void> | void;
  onThinkingDelta?(text: string): Promise<void> | void;
  onUsage?(usage: ModelUsage): Promise<void> | void;
  onProviderSessionId?(sessionId: string): Promise<void> | void;
  executeTool?(call: ToolCallPart): Promise<ToolResultMessage>;
  onProviderToolStart?(call: ToolCallPart): Promise<void> | void;
  onProviderToolEnd?(result: { toolCallId: string; toolName: string; text: string; isError: boolean }): Promise<void> | void;
  requestQuestion?(input: { title: string; options?: Array<{ label: string; value: string; description?: string }>; placeholder?: string }): Promise<string | undefined>;
};
export interface ModelClient {
  complete(input: ModelInput, signal?: AbortSignal, stream?: ModelStreamCallbacks): Promise<AssistantMessage>;
  resetSessionContinuation?(sessionId: string): Promise<void> | void;
}
export class HeuristicModelClient implements ModelClient { async complete(input: ModelInput): Promise<AssistantMessage> { const last = input.messages[input.messages.length - 1]; const text = last ? getText(last) : ""; const lower = text.toLowerCase(); const toolCalls: ToolCallPart[] = []; const createMatch = lower.match(/create (?:a |an )?(?:crewcode )?plugin(?: named| called)? ([a-z0-9-_]+)/i); if (createMatch?.[1]) { const kind = lower.includes("exec") || lower.includes("agent provider") ? "exec-agent" : "static-panel"; toolCalls.push({ type: "toolCall", id: `tool_${Date.now()}_create`, name: "createPlugin", arguments: { id: createMatch[1], kind, out: "." } }); } if (lower.includes("validate") && lower.includes("plugin")) { toolCalls.push({ type: "toolCall", id: `tool_${Date.now()}_validate`, name: "validatePlugin", arguments: { path: "." } }); } if (toolCalls.length > 0) return { role: "assistant", content: [{ type: "text", text: "I will use CrewCoder's local tools to perform the requested action." }, ...toolCalls], stopReason: "tool_calls", timestamp: Date.now() }; return assistantText(["CrewCoder loop is wired and ready.", "", "No automatic tool call was selected by the built-in heuristic model.", "Set CREWCODER_MODEL_COMMAND to connect a real model/tool-calling backend, or use direct CLI commands such as:", "- crewcoder plugin create my-panel --kind static-panel", "- crewcoder plugin validate ./my-panel"].join("\n")); } }
export class CommandModelClient implements ModelClient { constructor(private readonly command: string) {} async complete(input: ModelInput, signal?: AbortSignal): Promise<AssistantMessage> { const payload = JSON.stringify(input); const output = await runCommandModel(this.command, payload, signal); return parseAssistantOutput(output); } }
export function createModelClientFromEnv(): ModelClient { const command = process.env.CREWCODER_MODEL_COMMAND; return command && command.trim() ? new CommandModelClient(command) : new HeuristicModelClient(); }
function inferPluginKind(lower: string): string {
  if (lower.includes("typescript") || lower.includes("react")) return "typescript-panel";
  if (lower.includes("repo") || lower.includes("index") || lower.includes("todo")) return "repo-indexer";
  if (lower.includes("write") || lower.includes("handoff")) return "workspace-writer";
  if (lower.includes("mock")) return "mock-agent";
  if (lower.includes("http")) return "http-agent";
  if (lower.includes("openai") || lower.includes("local llm")) return "openai-agent";
  if (lower.includes("exec") || lower.includes("agent provider") || lower.includes("aider")) return "exec-agent";
  if (lower.includes("mcp")) return "mcp";
  if (lower.includes("browser")) return "browser-action";
  if (lower.includes("git") || lower.includes("risk lens")) return "git-lens";
  if (lower.includes("mission") || lower.includes("ci")) return "mission-widget";
  return "static-panel";
}

function parseAssistantOutput(output: string): AssistantMessage { try { const parsed = JSON.parse(output) as AssistantMessage; if (parsed.role === "assistant" && Array.isArray(parsed.content)) return parsed; } catch {} return assistantText(output.trim() || "(empty model response)"); }
function runCommandModel(command: string, stdin: string, signal?: AbortSignal): Promise<string> { return new Promise((resolve, reject) => { const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] }); let stdout = ""; let stderr = ""; const abort = () => child.kill("SIGTERM"); signal?.addEventListener("abort", abort, { once: true }); child.stdout.on("data", (chunk) => { stdout += chunk.toString(); }); child.stderr.on("data", (chunk) => { stderr += chunk.toString(); }); child.on("error", reject); child.on("close", (code) => { signal?.removeEventListener("abort", abort); if (code !== 0) { reject(new Error(stderr || `Model command exited with code ${code}`)); return; } resolve(stdout); }); child.stdin.end(stdin); }); }
