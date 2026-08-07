import type { AgentEvent } from "../core/events.js";
import type { ToolCallPart, ToolResultMessage, TextPart } from "../core/messages.js";
import type { GitIssueReference, GitReviewSummary, GitStatus } from "../core/git-workflow.js";
import type { SessionCheckpoint, SessionCheckpointPreview } from "../core/session-checkpoints.js";
import type { JsonObjectSchema, ToolContext, ToolResult } from "../core/tool-types.js";

export type CrewCoderExtEventName = "session_start" | "context" | "before_tool_call" | "after_tool_call" | "agent_event";

export type CrewCoderExtEventMap = {
  session_start: { reason: "startup" | "reload"; cwd: string; sessionId?: string };
  context: { cwd: string; sessionId: string; prompt: string; mode: string };
  before_tool_call: { toolCall: ToolCallPart; context: ToolContext };
  after_tool_call: { toolCall: ToolCallPart; result: ToolResultMessage; context: ToolContext };
  agent_event: AgentEvent;
};

export type CrewCoderExtCheckpoints = {
  create(reason: string): Promise<SessionCheckpoint>;
  list(): Promise<SessionCheckpoint[]>;
  preview(checkpointId: string): Promise<SessionCheckpointPreview>;
};

export type CrewCoderExtGit = {
  status(): Promise<GitStatus>;
  currentBranch(): Promise<string | undefined>;
  createCheckpoint(reason: string): Promise<SessionCheckpoint>;
  changedFiles(): Promise<string[]>;
  issueReferences(): Promise<GitIssueReference[]>;
  reviewSummary(): Promise<GitReviewSummary>;
};

export type CrewCoderExtContext = {
  cwd: string;
  sessionId?: string;
  mode: "tui" | "json" | "print";
  hasUI: boolean;
  signal?: AbortSignal;
  ui: CrewCoderExtUI;
  checkpoints: CrewCoderExtCheckpoints;
  git: CrewCoderExtGit;
};

export type CrewCoderExtUiComponent =
  | { kind: "markdown"; text: string }
  | { kind: "details"; items: Array<{ label: string; value: string }> }
  | { kind: "table"; columns: Array<{ key: string; label: string }>; rows: Array<Record<string, string | number | boolean | null | undefined>> }
  | { kind: "actionList"; actions: Array<{ id: string; label: string; description?: string }> };

export type CrewCoderExtUiAction = { id: string; label: string; description?: string };

export type CrewCoderExtUI = {
  notify(message: string, level?: "info" | "success" | "warning" | "error"): void;
  confirm(title: string, message?: string): Promise<boolean>;
  input(title: string, options?: { placeholder?: string; defaultValue?: string }): Promise<string | undefined>;
  select<T extends string>(title: string, options: T[] | Array<{ label: string; value: T; description?: string }>): Promise<T | undefined>;
  component(title: string, component: CrewCoderExtUiComponent, options?: { message?: string; actions?: CrewCoderExtUiAction[] }): Promise<string | undefined>;
};

export type CrewCoderExtEventResult =
  | void
  | { context?: string }
  | { block?: boolean; reason?: string; context?: string }
  | { action?: "allow" | "block" | "modify"; reason?: string; args?: Record<string, unknown>; context?: string };

export type CrewCoderExtEventHandler<K extends CrewCoderExtEventName = CrewCoderExtEventName> = (
  event: CrewCoderExtEventMap[K],
  ctx: CrewCoderExtContext
) => CrewCoderExtEventResult | Promise<CrewCoderExtEventResult>;

export type CrewCoderExtAgentEventOptions = {
  /** Optional AgentEvent.type allow-list. Omit to receive every emitted agent event. */
  types?: Array<AgentEvent["type"]>;
};

export type CrewCoderExtToolUpdate = { content: TextPart[]; details?: Record<string, unknown> };

export type CrewCoderExtToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>> = {
  name: string;
  label?: string;
  icon?: string;
  category?: string;
  renderer?: string;
  description: string;
  parameters?: JsonObjectSchema;
  isMutation?: boolean;
  prepareArguments?(args: Record<string, unknown>): Record<string, unknown>;
  execute(
    toolCallId: string,
    params: TArgs,
    signal: AbortSignal | undefined,
    onUpdate: ((update: CrewCoderExtToolUpdate) => void) | undefined,
    ctx: CrewCoderExtContext & { toolContext: ToolContext }
  ): Promise<ToolResult>;
};

export type CrewCoderExtSessionEntry = {
  extensionId: string;
  customType: string;
  data?: unknown;
  timestamp: number;
};

export type CrewCoderExtCommandContext = CrewCoderExtContext & {
  writeSessionEntry(customType: string, data?: unknown): void;
  getSessionEntries(): CrewCoderExtSessionEntry[];
};

export type CrewCoderExtCommandDefinition = {
  description?: string;
  handler(args: string, ctx: CrewCoderExtCommandContext): void | Promise<void>;
};

export type CrewCoderExtRegisteredCommand = CrewCoderExtCommandDefinition & {
  name: string;
  extensionId: string;
};

export type CrewCoderExtAPI = {
  handleEvent<K extends Exclude<CrewCoderExtEventName, "agent_event">>(event: K, handler: CrewCoderExtEventHandler<K>): void;
  handleEvent(event: "agent_event", handler: CrewCoderExtEventHandler<"agent_event">): void;
  handleEvent(event: "agent_event", options: CrewCoderExtAgentEventOptions, handler: CrewCoderExtEventHandler<"agent_event">): void;
  defineTool<TArgs extends Record<string, unknown> = Record<string, unknown>>(definition: CrewCoderExtToolDefinition<TArgs>): void;
  defineCommand(name: string, definition: CrewCoderExtCommandDefinition): void;
  writeSessionEntry(customType: string, data?: unknown): void;
  getSessionEntries(): CrewCoderExtSessionEntry[];
  getDefinedTools(): CrewCoderExtToolDefinition[];
  getDefinedCommands(): CrewCoderExtRegisteredCommand[];
};

export type CrewCoderExtensionModule = (api: CrewCoderExtAPI) => void | Promise<void>;
