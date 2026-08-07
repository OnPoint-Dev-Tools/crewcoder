import type { AgentEventSink } from "./events.js";
import type { TextPart } from "./messages.js";
import type { SandboxContext } from "./sandbox.js";
import type { ResolvedAgentMode } from "./types.js";
import type { IntegrationProfile } from "./integration-profile.js";
export type ToolExecutionMode = "sequential" | "parallel";
export type JsonSchema = boolean | JsonObjectSchema | JsonArraySchema | JsonStringSchema | JsonNumberSchema | JsonBooleanSchema;
export type JsonObjectSchema = { type: "object"; properties?: Record<string, JsonSchema>; required?: string[]; additionalProperties?: boolean | JsonSchema; description?: string };
export type JsonArraySchema = { type: "array"; items?: JsonSchema; description?: string };
export type JsonStringSchema = { type: "string"; description?: string; enum?: string[]; minLength?: number; maxLength?: number };
export type JsonNumberSchema = { type: "number" | "integer"; description?: string; minimum?: number; maximum?: number };
export type JsonBooleanSchema = { type: "boolean"; description?: string };
export type ToolResult = { content: TextPart[]; details?: Record<string, unknown>; terminate?: boolean };
export type ChildWorkerDelegateRequest = { worker: string; task: string; maxIterations?: number };
export type ChildWorkerDelegateResult = { worker: string; sessionId: string; summary: string; mutationLog: string[] };
/**
 * Optional host-provided text file I/O. When present, `read`/`write`/`edit` route
 * through it instead of `node:fs`, so an embedding host can serve files the local
 * process cannot see — unsaved editor buffers, or a remote workspace over SFTP.
 *
 * Each method is independently optional: a host may offer reads without writes.
 * Missing methods fall back to local disk. Paths are always absolute.
 *
 * Text only. Binary/image reads always use local disk.
 */
export type TextFileHost = {
  readTextFile?(absolutePath: string): Promise<string>;
  writeTextFile?(absolutePath: string, content: string): Promise<void>;
};

export type ToolContext = { cwd: string; externalDirectories?: string[]; mode: ResolvedAgentMode; integrationProfile?: IntegrationProfile; sessionId: string; mutationLog: string[]; sandbox?: SandboxContext; emit?: AgentEventSink; textFiles?: TextFileHost; delegateWorker?: (request: ChildWorkerDelegateRequest, signal?: AbortSignal) => Promise<ChildWorkerDelegateResult> };
export type ToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>> = {
  name: string;
  description: string;
  parameters?: JsonObjectSchema;
  executionMode?: ToolExecutionMode;
  isMutation?: boolean;
  parse(args: Record<string, unknown>): TArgs;
  execute(args: TArgs, context: ToolContext, signal?: AbortSignal): Promise<ToolResult>;
};
export function textResult(text: string, details?: Record<string, unknown>): ToolResult { return { content: [{ type: "text", text }], details }; }
